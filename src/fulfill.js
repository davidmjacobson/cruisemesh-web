import { getCheckoutSession } from "./stripe.js";
import { PLAN, generateFamilyToken, provisionFamily, relaySetupLink } from "./relay.js";
import { sendCredentialEmail } from "./email.js";

// Fulfillment is idempotent and callable from both the Stripe webhook and the
// success page, whichever fires first (Stripe recommends exactly this). Each
// step records completion in D1 so retries only redo what is still missing:
//   1. verify the session is paid, insert the purchase row (token minted once)
//   2. provision the token on the relay via the admin API
//   3. email the credentials (skipped entirely until RESEND_API_KEY is set)

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
    // ON CONFLICT DO NOTHING: if the webhook and the success page race, only
    // one insert wins and both paths read back the winning token.
    await env.DB.prepare(
      `INSERT INTO purchases (session_id, customer_id, email, family_token, relay_url, plan, status, created_ms, expires_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8)
       ON CONFLICT (session_id) DO NOTHING`,
    )
      .bind(
        sessionId,
        session.customer ?? null,
        session.customer_details?.email ?? "",
        generateFamilyToken(),
        env.RELAY_URL,
        PLAN.id,
        now,
        now + PLAN.days * 24 * 60 * 60 * 1000,
      )
      .run();
    purchase = await getPurchase(env, sessionId);
    // A row that vanishes between insert and read-back means something is
    // wrong with D1, not that the customer did not pay. Throw so the webhook
    // 500s and Stripe retries, instead of a TypeError on the next line.
    if (!purchase) throw new Error(`purchase row missing after insert for ${sessionId}`);
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
        await sendCredentialEmail(env, purchase, relaySetupLink("https://cruisemesh.app", purchase.relay_url, purchase.family_token));
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
