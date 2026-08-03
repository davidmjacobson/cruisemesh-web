import { getCheckoutSession } from "./stripe.js";
import { PLAN, generateFamilyToken, provisionFamily, relaySetupLink } from "./relay.js";
import { sendCredentialEmail, sendRenewalEmail } from "./email.js";
import { extendedExpiry, extensionBase, renewalTargetForSession, resolveRenewalCode } from "./renew.js";
import { sendOpsEmail } from "./ops.js";

// Fulfillment is idempotent and callable from both the Stripe webhook and the
// success page, whichever fires first (Stripe recommends exactly this). Each
// step records completion in D1 so retries only redo what is still missing:
//   1. verify the session is paid, insert the purchase row (token minted once)
//   2. provision the token on the relay via the admin API
//   3. email the credentials (skipped entirely until RESEND_API_KEY is set)
//
// A renewal runs the same three steps with one difference that is the whole
// point of renewing: step 1 reuses the family token of the pass being renewed
// instead of minting one, so every phone already set up keeps working and
// step 3 has no setup card to send. The relay's provisioning endpoint upserts
// on the token, so step 2 is unchanged — it moves the existing family's
// expiry rather than creating a second one.

function getPurchase(env, sessionId) {
  return env.DB.prepare("SELECT * FROM purchases WHERE session_id = ?1").bind(sessionId).first();
}

/// Which pass this checkout extends, if any, and how it was identified.
/// The code is the primary key; the purchase id in metadata is a fallback for
/// a code that expired between the click and the payment — asynchronous
/// payment methods settle days later, and a customer who paid on a page
/// promising "nothing to set up again" must not be handed a fresh token
/// because a link aged out in the meantime.
async function resolveRenewalTarget(env, session, sessionId, nowMs) {
  const code = session.metadata?.renew_code ?? null;
  const origin = session.metadata?.renew_session ?? null;
  if (!code && !origin) return null;

  const byCode = code ? await resolveRenewalCode(env, code, nowMs) : null;
  if (byCode) return byCode.purchase;

  const bySession = await renewalTargetForSession(env, origin);
  if (bySession) {
    console.warn(`renewal code for ${sessionId} did not resolve; extended via purchase ${origin}`);
    return bySession;
  }
  return null;
}

/// Insert the purchase row for a paid checkout, minting a token for a new
/// pass or reusing the renewed pass's token.
///
/// The renewal path is a compare-and-set loop rather than a plain insert.
/// Reading the live expiry, adding thirty days and inserting is three
/// independent D1 statements with no transaction around them, so two renewals
/// of the same family landing together would both read expiry E and both
/// write E+30: two charges, one extension, and two rows left 'active' mailing
/// duplicate reminders forever. The guard refuses to insert if any row for
/// this family already reaches past the date the extension was computed from,
/// so the loser re-reads the newly extended date and stacks onto it — two
/// payments, sixty days, which is what was paid for.
async function insertPurchaseRow(env, sessionId, session, nowMs) {
  for (let attempt = 0; attempt < 4; attempt++) {
    // A racing runner for this same session may have inserted already.
    const existing = await getPurchase(env, sessionId);
    if (existing) return existing;

    const renewing = await resolveRenewalTarget(env, session, sessionId, nowMs);
    const orphaned = Boolean((session.metadata?.renew_code || session.metadata?.renew_session) && !renewing);

    // Two different dates, and conflating them strands people. The *witness*
    // is what the family's live row said a moment ago — the value the
    // compare-and-set is betting has not moved. The *base* is what the new
    // term is measured from, which for a refunded pass is today rather than a
    // date the refund already paid back. Binding the base as the witness made
    // the guard compare a refunded family against 0, so it refused every
    // attempt and the customer was charged and never fulfilled.
    const witness = renewing ? renewing.expires_ms ?? 0 : 0;
    const base = renewing ? extensionBase(renewing) : null;
    const expiresMs = renewing
      ? extendedExpiry(base, nowMs)
      : nowMs + PLAN.days * 24 * 60 * 60 * 1000;
    // Stored lowercased: `=` in SQLite is case-sensitive, and the renewal
    // form is the only way back in for someone who no longer has the email.
    const email = String(session.customer_details?.email ?? renewing?.email ?? "").trim().toLowerCase();

    const result = await env.DB.prepare(
      `INSERT INTO purchases (session_id, customer_id, email, family_token, relay_url, plan, status, created_ms, expires_ms, renewed_from)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, ?9
        WHERE ?9 IS NULL
           OR NOT EXISTS (
                SELECT 1 FROM purchases
                 WHERE family_token = ?4 AND COALESCE(expires_ms, 0) > ?10
              )
       ON CONFLICT (session_id) DO NOTHING`,
    )
      .bind(
        sessionId,
        session.customer ?? null,
        email,
        renewing ? renewing.family_token : generateFamilyToken(),
        renewing ? renewing.relay_url : env.RELAY_URL,
        PLAN.id,
        nowMs,
        expiresMs,
        renewing ? renewing.session_id : null,
        witness,
      )
      .run();

    if (result.meta.changes > 0) {
      // Alerted only by the runner that actually wrote the row, and only
      // once: alerting before the insert pages the operator again for every
      // retry and for every racing runner, turning one customer event into a
      // pile of identical ALERTs.
      if (orphaned) {
        console.error(`renewal for ${sessionId} could not be matched to a pass; issued a new one`);
        await alertOrphanedRenewal(env, sessionId, session);
      }
      return getPurchase(env, sessionId);
    }
    // Zero rows written has two causes, and only one of them is contention:
    // a renewal whose witness went stale (loop and stack onto the new date),
    // or the ordinary webhook/success-page race on this same session, which
    // the next iteration resolves by reading the row the other runner wrote.
    if (renewing) {
      console.warn(`renewal insert for ${sessionId} lost its guard; retrying (attempt ${attempt + 1})`);
    }
  }
  return null;
}

/// A paid renewal that could not be matched to a pass is the one case where
/// the promise on the checkout page ("nothing to set up again") turns out to
/// be false, so it pages the operator rather than living in a log line.
async function alertOrphanedRenewal(env, sessionId, session) {
  try {
    await sendOpsEmail(
      env,
      "ALERT: renewal fulfilled as a new pass",
      [
        `Checkout ${sessionId} was started as a renewal, but neither its code nor its`,
        "originating purchase could be matched at fulfillment time, so it was fulfilled",
        "as a brand-new pass: a new family token, and every phone on it needs setting up",
        "again — which is not what the customer was promised when they paid.",
        "",
        `renew_code:    ${session.metadata?.renew_code ?? "(none)"}`,
        `renew_session: ${session.metadata?.renew_session ?? "(none)"}`,
        `email:         ${session.customer_details?.email ?? "(none)"}`,
        "",
        "Check whether the customer's old pass still exists in D1. If it does, the kind",
        "fix is to move the new expiry onto the old family token and refund or void the",
        "duplicate, so their phones keep working.",
      ].join("\n"),
    );
  } catch (error) {
    console.error(`orphaned-renewal alert failed for ${sessionId}: ${error}`);
  }
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
    purchase = await insertPurchaseRow(env, sessionId, session, now);
    // A row that is neither found nor inserted after the attempts above means
    // something is wrong with D1, not that the customer did not pay. Throw so
    // the webhook 500s and Stripe retries, instead of a TypeError below.
    if (!purchase) throw new Error(`purchase row missing after insert for ${sessionId}`);
  }

  // Renewal bookkeeping runs on every call, not only the one that inserted.
  // D1 has no transactions, so a runner that dies between the insert and these
  // updates would otherwise leave the superseded row 'active' forever — and
  // that row is what mails "your pass expires in 3 days" about a date the
  // customer has already paid past. Both statements are idempotent.
  if (purchase.renewed_from) {
    await env.DB.prepare(
      "UPDATE purchases SET status = 'renewed' WHERE session_id = ?1 AND status = 'active'",
    )
      .bind(purchase.renewed_from)
      .run();
    // Every outstanding code for this family, not just the ones filed under
    // the row this renewal superseded. A code minted against the original
    // purchase resolves forward through the chain, so redeeming by the
    // superseded row alone left the code the customer actually clicked
    // looking unspent forever — which is exactly the record support reads
    // when the orphaned-renewal alert asks them to work out what happened.
    // Redeeming by code is not possible on a retry: it never re-reads the
    // Stripe session. Resolution deliberately ignores redeemed_ms, so a
    // second deliberate payment from the same link still works.
    // Bounded to codes that already existed when this renewal was paid for.
    // This block re-runs on every fulfillment call (a bookmarked success page
    // is enough), and without the bound a later re-run would spend a code the
    // expiry cron minted and mailed *after* the renewal — stamping it with a
    // redemption time earlier than its own creation, and quietly voiding the
    // send cooldown that code was still under.
    await env.DB.prepare(
      `UPDATE renewals SET redeemed_ms = ?1, redeemed_session_id = ?2
        WHERE redeemed_ms IS NULL
          AND created_ms <= ?1
          AND session_id IN (SELECT session_id FROM purchases WHERE family_token = ?3)`,
    )
      .bind(purchase.created_ms, purchase.session_id, purchase.family_token)
      .run();
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
        const setupLink = relaySetupLink("https://cruisemesh.app", purchase.relay_url, purchase.family_token);
        // A renewal has nothing to set up — same token, same card, the phones
        // that already work keep working — so it gets the confirmation email
        // instead of the credential email, which would read as a fresh pass
        // needing a fresh setup pass over every phone.
        await (purchase.renewed_from
          ? sendRenewalEmail(env, purchase, setupLink)
          : sendCredentialEmail(env, purchase, setupLink));
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
