import { getCheckoutSession } from "./stripe.js";
import { PLAN, generateFamilyToken, provisionFamily, relaySetupLink } from "./relay.js";
import { sendCredentialEmail, sendRenewalEmail } from "./email.js";

// Fulfillment is idempotent and callable from both the Stripe webhook and the
// success page, whichever fires first (Stripe recommends exactly this). Each
// step records completion in D1 so retries only redo what is still missing:
//   1. verify the session is paid, insert the purchase row (token minted once)
//   2. provision the token on the relay via the admin API
//   3. email the credentials (skipped entirely until RESEND_API_KEY is set)
//
// A renewal (Stripe `metadata.renewal_of`, set by src/renew.js) runs the same
// three steps with two differences: step 1 reuses the prior purchase's family
// token and address instead of minting or reading either, and step 3 confirms
// the new date rather than re-sending a credential the phones already hold.
// Everything a renewal needs comes out of the prior D1 row, nothing from the
// caller.

function getPurchase(env, sessionId) {
  return env.DB.prepare("SELECT * FROM purchases WHERE session_id = ?1").bind(sessionId).first();
}

export async function fulfillCheckoutSession(env, sessionId) {
  let purchase = await getPurchase(env, sessionId);

  if (!purchase) {
    let session;
    try {
      session = await getCheckoutSession(env, sessionId);
    } catch (error) {
      // An unknown session id is a bad URL, not an outage: fall through to
      // the "payment not completed" page rather than "something went wrong".
      if (error.status === 404 || error.stripeCode === "resource_missing") return null;
      throw error;
    }
    // "no_payment_required" is a fully completed $0 checkout: a 100%-off
    // promotion code (friends-and-family passes). Everything else unpaid is
    // an unfinished or failed checkout.
    if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") return null;
    const now = Date.now();
    const priorSessionId = session.metadata?.renewal_of ?? null;
    const priorRow = priorSessionId ? await getPurchase(env, priorSessionId) : null;
    // Status is re-checked here, not only when the renewal link was followed:
    // a pass can be refunded or suspended while the buyer is still on the
    // Stripe page. Reusing its token then would hand a revoked family another
    // 30 days, so a prior that is no longer active is treated exactly like a
    // prior that is no longer there.
    const prior = priorRow?.status === "active" ? priorRow : null;
    if (priorSessionId && !prior) {
      // The customer has paid, so fall through and give them a working new
      // pass with its own credentials rather than nothing — but say so
      // loudly, because their phones will need setting up again.
      console.error(
        `renewal ${sessionId} names a prior session that is ${priorRow ? `no longer active (${priorRow.status})` : "unknown"}; issuing a new pass instead`,
      );
    }
    // Renewing early must not throw away days already paid for, and renewing
    // late must not back-date: extend from whichever is later, now or the old
    // expiry. Computed once, at insert, so webhook retries cannot stack days.
    const extendFrom = prior?.expires_ms ? Math.max(now, prior.expires_ms) : now;
    // ON CONFLICT DO NOTHING: if the webhook and the success page race, only
    // one insert wins and both paths read back the winning token.
    await env.DB.prepare(
      `INSERT INTO purchases (session_id, customer_id, email, family_token, relay_url, plan, status, created_ms, expires_ms, renewal_of)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, ?9)
       ON CONFLICT (session_id) DO NOTHING`,
    )
      .bind(
        sessionId,
        session.customer ?? null,
        // The renewal path never reads an address off the new checkout: the
        // only address it will ever mail is the one already on file.
        prior ? prior.email : session.customer_details?.email ?? "",
        // The whole point of a renewal: same token, so no family phone has to
        // be set up again.
        prior ? prior.family_token : generateFamilyToken(),
        prior ? prior.relay_url : env.RELAY_URL,
        PLAN.id,
        now,
        extendFrom + PLAN.days * 24 * 60 * 60 * 1000,
        prior ? prior.session_id : null,
      )
      .run();
    purchase = await getPurchase(env, sessionId);
    // A row that vanishes between insert and read-back means something is
    // wrong with D1, not that the customer did not pay. Throw so the webhook
    // 500s and Stripe retries, instead of a TypeError on the next line.
    if (!purchase) throw new Error(`purchase row missing after insert for ${sessionId}`);
    if (prior) {
      // The prior row keeps its old expires_ms, and the reminder job selects
      // on that date alone — so a buyer who renews BEFORE the T-3 reminder
      // fires would still be told their pass "expires in 3 days" about a date
      // their renewal already moved. Marking the old date as reminded-for
      // retires that send; the new row earns its own reminder near the new
      // date. Idempotent, so the webhook/success-page race can run it twice.
      await env.DB.prepare(
        "UPDATE purchases SET expiry_reminded_for_ms = expires_ms WHERE session_id = ?1",
      )
        .bind(prior.session_id)
        .run();
    }
  }

  if (!purchase.provisioned_ms) {
    try {
      await provisionFamily(env, purchase.family_token, purchase.expires_ms);
      await env.DB.prepare(
        "UPDATE purchases SET provisioned_ms = ?1 WHERE session_id = ?2 AND provisioned_ms IS NULL",
      )
        .bind(Date.now(), sessionId)
        .run();
      purchase = await getPurchase(env, sessionId);
    } catch (error) {
      console.error(`provisioning failed for ${sessionId}: ${error}`);
    }
  }

  if (env.RESEND_API_KEY && purchase.email && !purchase.email_sent_ms) {
    const claim = await env.DB.prepare(
      "UPDATE purchases SET email_sent_ms = ?1 WHERE session_id = ?2 AND email_sent_ms IS NULL",
    )
      .bind(Date.now(), sessionId)
      .run();
    if (claim.meta.changes > 0) {
      try {
        if (purchase.renewal_of) {
          // A renewal confirms the new date to the address on file. The setup
          // card is neither re-sent nor re-displayed: the phones already have
          // it, and the token has not changed.
          await sendRenewalEmail(env, purchase);
        } else {
          await sendCredentialEmail(env, purchase, relaySetupLink("https://cruisemesh.app", purchase.relay_url, purchase.family_token));
        }
      } catch (error) {
        console.error(`credential email failed for ${sessionId}: ${error}`);
        await env.DB.prepare("UPDATE purchases SET email_sent_ms = NULL WHERE session_id = ?1").bind(sessionId).run();
      }
    }
    purchase = await getPurchase(env, sessionId);
  } else if (!purchase.email_sent_ms) {
    // Never let a credential email go missing quietly. Until RESEND_API_KEY
    // is set the success page is the only copy of the setup link a buyer ever
    // gets, and nothing else in the system records that fact.
    console.error(
      `credentials not emailed for ${sessionId}: ` +
        (env.RESEND_API_KEY ? "no email address on the checkout session" : "RESEND_API_KEY is not configured"),
    );
  }

  return purchase;
}
