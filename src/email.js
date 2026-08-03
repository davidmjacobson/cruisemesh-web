import { PLAN } from "./relay.js";
import { extensionBase } from "./renew.js";

export function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Machine formats ("Tue, 25 Aug 2026 09:38:38 GMT") read as an error message
// in a receipt. Formatted by hand rather than via toLocaleDateString so the
// output does not depend on which ICU data the Workers runtime carries.
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

export function formatExpiry(expiresMs) {
  if (!expiresMs) return "never";
  const date = new Date(expiresMs);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

// Where a buyer goes to get a pass, and where they go to extend the one they
// have. Renewing keeps the family token, so it is the path that costs nobody
// a second setup; buying is for families without a pass at all.
const PURCHASE_URL = "https://cruisemesh.app/pass/";
export const RENEW_URL = "https://cruisemesh.app/pass/renew/";

export const renewLink = (code) => `${RENEW_URL}?code=${encodeURIComponent(code)}`;

// "in 3 days" is only right on the first day of the reminder window; a pass
// that lands inside the window some other way (a short pass, a cron that was
// down yesterday) must not be told the wrong number.
export function daysUntil(expiresMs, nowMs) {
  const days = Math.ceil((expiresMs - nowMs) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

export async function sendExpiryReminderEmail(env, purchase, nowMs = Date.now(), renewUrl = null) {
  const expiry = formatExpiry(purchase.expires_ms);
  const when = daysUntil(purchase.expires_ms, nowMs);
  // RENEWAL COPY: renewing extends the pass the family already has, on the
  // same setup card, so the honest promise is "nothing to set up again" —
  // paired with "nothing renews on its own", which is still true and is what
  // stops this reading as a subscription notice. `renewUrl` is a one-time
  // link for this pass; without one (no code could be minted) the email falls
  // back to the renewal page, which mails a fresh link on request.
  const renew = renewUrl || RENEW_URL;
  const text = [
    `Your Cruise Pass expires ${when}.`,
    "",
    `Internet delivery stops on ${expiry}. After that date, CruiseMesh no longer carries your family's messages over the internet.`,
    "",
    "Messaging nearby keeps working without a pass. Phones close to each other still reach one another over Bluetooth and local Wi-Fi, on the ship or ashore, with no internet at all.",
    "",
    `Nothing renews on its own and you will not be charged again. To keep internet delivery, extend this pass for another ${PLAN.days} days: ${renew}`,
    "",
    "Extending keeps your family's existing setup card, so there is nothing to set up again — every phone you already set up keeps working. Days are not lost by extending early: another 30 days is added to the date above, not to today.",
    "",
    `Starting a pass for a different family instead? That is a new pass, with its own setup card: ${PURCHASE_URL}`,
    "",
    "Need help? Reply to this email, or write to support@cruisemesh.app.",
  ].join("\n");

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#1a222a;line-height:1.6">
      <h1 style="font-size:1.4rem">Your Cruise Pass expires ${escapeHtml(when)}</h1>
      <p>Internet delivery stops on <strong>${escapeHtml(expiry)}</strong>. After that date, CruiseMesh no longer carries your family's messages over the internet.</p>
      <p>Messaging nearby keeps working without a pass. Phones close to each other still reach one another over Bluetooth and local Wi-Fi, on the ship or ashore, with no internet at all.</p>
      <p>Nothing renews on its own and you will not be charged again. To keep internet delivery, extend this pass for another ${PLAN.days} days.</p>
      <p><a href="${escapeHtml(renew)}" style="display:inline-block;padding:12px 20px;border-radius:12px;background:#0d7186;color:#fff;text-decoration:none;font-weight:700">Extend this pass</a></p>
      <p>Extending keeps your family's existing setup card, so there is <strong>nothing to set up again</strong> — every phone you already set up keeps working. Days are not lost by extending early: another ${PLAN.days} days is added to the date above, not to today.</p>
      <p style="color:#556472;font-size:0.9rem">Starting a pass for a different family instead? That is <a href="${PURCHASE_URL}">a new pass</a>, with its own setup card.</p>
      <p style="color:#556472;font-size:0.9rem">Need help? Reply to this email, or write to <a href="mailto:support@cruisemesh.app">support@cruisemesh.app</a>.</p>
    </div>`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      // Same sender identity as the credential email: the buyer already has
      // one message from this address, so the reminder threads with it in
      // most mail clients instead of arriving as a stranger.
      from: `CruiseMesh <${env.EMAIL_FROM}>`,
      to: purchase.email,
      reply_to: "support@cruisemesh.app",
      subject: `Your Cruise Pass expires ${when}`,
      text,
      html,
    }),
  });

  // Throw so the caller can release its claim on this row and try again on
  // the next daily run, rather than recording a reminder that never landed.
  if (!response.ok) {
    throw new Error(`Resend rejected the expiry reminder (HTTP ${response.status}): ${await response.text()}`);
  }
}

// Sent when someone asks /pass/renew/ for a link. It is the only proof of
// ownership in the flow, so it must be readable by the person who bought the
// pass and useless to everyone else: no family token, no setup card, and a
// link that does nothing until it is paid for.
export async function sendRenewalLinkEmail(env, purchase, url) {
  // Derived through extensionBase for the same reason the renewal page is: a
  // refunded pass no longer runs to its old date, and saying it does sets up
  // a payment against a promise fulfillment will not keep.
  const base = extensionBase(purchase);
  const expiry = formatExpiry(base);
  const standing = purchase.status === "refunded"
    ? "This pass was refunded, so internet delivery is not running. Extending starts a fresh 30 days from today."
    : base && base <= Date.now()
      ? `Internet delivery for this pass stopped on ${expiry}.`
      : `Internet delivery for this pass runs until ${expiry}.`;
  const text = [
    "Here is your link to extend your Cruise Pass.",
    "",
    standing,
    "",
    `Extend it for another ${PLAN.days} days: ${url}`,
    "",
    "Extending keeps your family's existing setup card. Nothing needs setting up again, and every phone you already set up keeps working.",
    "",
    "If you did not ask for this link, you can ignore this email. It only leads to a payment page; it does not give anyone access to your family's messages, and nothing has been charged.",
    "",
    "Need help? Reply to this email, or write to support@cruisemesh.app.",
  ].join("\n");

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#1a222a;line-height:1.6">
      <h1 style="font-size:1.4rem">Extend your Cruise Pass</h1>
      <p>${escapeHtml(standing)}</p>
      <p><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;border-radius:12px;background:#0d7186;color:#fff;text-decoration:none;font-weight:700">Extend for another ${PLAN.days} days</a></p>
      <p>Extending keeps your family's existing setup card. <strong>Nothing needs setting up again</strong>, and every phone you already set up keeps working.</p>
      <p style="color:#556472;font-size:0.9rem">If you did not ask for this link, you can ignore this email. It only leads to a payment page; it does not give anyone access to your family's messages, and nothing has been charged.</p>
      <p style="color:#556472;font-size:0.9rem">Need help? Reply to this email, or write to <a href="mailto:support@cruisemesh.app">support@cruisemesh.app</a>.</p>
    </div>`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: `CruiseMesh <${env.EMAIL_FROM}>`,
      to: purchase.email,
      reply_to: "support@cruisemesh.app",
      subject: "Extend your Cruise Pass",
      text,
      html,
    }),
  });

  // Thrown so the caller leaves the code unsent and a later request can try
  // again — a link that was recorded as delivered but never arrived leaves a
  // buyer with no way through at all.
  if (!response.ok) {
    throw new Error(`Resend rejected the renewal link email (HTTP ${response.status}): ${await response.text()}`);
  }
}

// Sent after a renewal is paid. The whole message is "your existing setup
// keeps working" — the setup card is included only for a phone that never had
// it, and is deliberately at the bottom, because treating this like a fresh
// pass is what would send a family round every phone for no reason.
export async function sendRenewalEmail(env, purchase, setupLink) {
  const expiry = formatExpiry(purchase.expires_ms);
  const text = [
    `Your Cruise Pass now runs until ${expiry}.`,
    "",
    "There is nothing to set up. Your family keeps the same setup card, and every phone already set up keeps working — internet delivery simply continues.",
    "",
    "Nothing renews on its own, so you will not be charged again. We will email you a few days before this date.",
    "",
    `Adding a phone that never had the pass? Open this link on it: ${setupLink}`,
    "",
    "Need help? Reply to this email, or write to support@cruisemesh.app.",
  ].join("\n");

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#1a222a;line-height:1.6">
      <h1 style="font-size:1.4rem">Your Cruise Pass now runs until ${escapeHtml(expiry)}</h1>
      <p><strong>There is nothing to set up.</strong> Your family keeps the same setup card, and every phone already set up keeps working — internet delivery simply continues.</p>
      <p>Nothing renews on its own, so you will not be charged again. We will email you a few days before this date.</p>
      <p style="color:#556472;font-size:0.9rem">Adding a phone that never had the pass? <a href="${escapeHtml(setupLink)}">Open this link on it</a>. Anyone with that link can use your family's internet delivery, so share it only with your own phones.</p>
      <p style="color:#556472;font-size:0.9rem">Need help? Reply to this email, or write to <a href="mailto:support@cruisemesh.app">support@cruisemesh.app</a>.</p>
    </div>`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: `CruiseMesh <${env.EMAIL_FROM}>`,
      to: purchase.email,
      reply_to: "support@cruisemesh.app",
      subject: `Your Cruise Pass now runs until ${expiry}`,
      text,
      html,
    }),
  });

  // Same contract as the credential email: fulfill.js clears email_sent_ms on
  // a throw, so the next retry sends it rather than recording a phantom send.
  if (!response.ok) {
    throw new Error(`Resend rejected the renewal confirmation (HTTP ${response.status}): ${await response.text()}`);
  }
}

export async function sendCredentialEmail(env, purchase, setupLink) {
  // Consumer copy says "internet delivery", never "relay" — relay wording is
  // confined to the Custom relay section, matching the app (see the comment
  // above ui_enter_a_complete_https_relay_url_and_token in strings.xml).
  // Step labels must match the app's buttons verbatim: Review, then Test and
  // use. "Test and save" is the Custom relay button and is wrong here.
  const expiry = formatExpiry(purchase.expires_ms);
  const text = [
    "Your Cruise Pass is ready.",
    "",
    "1. Open this link on the phone you want to set up:",
    setupLink,
    "2. Choose Review, and check the host CruiseMesh shows.",
    "3. Choose Test and use. CruiseMesh saves the pass only after that check succeeds.",
    "",
    "If the link did not open CruiseMesh, copy the setup card (the text starting CMRELAY1:) from the end of it, then open Settings -> Cruise Pass, choose Paste card, then Review.",
    "",
    "One pass covers your whole family, and each family phone needs this setup. Once the first phone is ready, use Set up another phone or Show setup QR in Settings -> Cruise Pass.",
    "",
    "Cruise Pass sets up internet delivery. It does not add contacts, and it does not share a phone's internet connection.",
    "",
    `Pass expires: ${expiry}`,
    "",
    "Anyone with this link can use your family's internet delivery, so share it only with your own phones.",
    "",
    "Need help? Reply to this email, or write to support@cruisemesh.app.",
    "",
    "Advanced: to enter the details by hand, open Settings -> Cruise Pass -> Custom relay.",
    `  Relay URL:   ${purchase.relay_url}`,
    `  Relay token: ${purchase.family_token}`,
  ].join("\n");

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#1a222a;line-height:1.6">
      <h1 style="font-size:1.4rem">Your Cruise Pass is ready</h1>
      <p><a href="${escapeHtml(setupLink)}" style="display:inline-block;padding:12px 20px;border-radius:12px;background:#0d7186;color:#fff;text-decoration:none;font-weight:700">Open in CruiseMesh</a></p>
      <ol>
        <li>Tap <strong>Open in CruiseMesh</strong> above, on the phone you want to set up.</li>
        <li>Choose <strong>Review</strong>, and check the host CruiseMesh shows.</li>
        <li>Choose <strong>Test and use</strong>. CruiseMesh saves the pass only after that check succeeds.</li>
      </ol>
      <p>If the link did not open CruiseMesh, copy the setup card (the text starting <code>CMRELAY1:</code>) from the end of it, then open <strong>Settings &rarr; Cruise Pass</strong>, choose <strong>Paste card</strong>, then <strong>Review</strong>.</p>
      <p>One pass covers your whole family, and each family phone needs this setup. Once the first phone is ready, use <strong>Set up another phone</strong> or <strong>Show setup QR</strong> in Settings &rarr; Cruise Pass.</p>
      <p>Cruise Pass sets up internet delivery. It does not add contacts, and it does not share a phone's internet connection.</p>
      <p>Pass expires: ${escapeHtml(expiry)}</p>
      <p>Anyone with this link can use your family's internet delivery, so share it only with your own phones.</p>
      <p style="color:#556472;font-size:0.9rem">Need help? Reply to this email, or write to <a href="mailto:support@cruisemesh.app">support@cruisemesh.app</a>.</p>
      <details style="margin-top:20px">
        <summary style="color:#556472;font-size:0.9rem;cursor:pointer">Advanced: enter the details by hand</summary>
        <p style="font-size:0.9rem">In CruiseMesh, open <strong>Settings &rarr; Cruise Pass &rarr; Custom relay</strong>.</p>
        <p style="font-family:monospace;background:#f3f6f8;padding:12px;border-radius:8px;word-break:break-all;font-size:0.9rem">
          Relay URL: ${escapeHtml(purchase.relay_url)}<br>
          Relay token: ${escapeHtml(purchase.family_token)}
        </p>
      </details>
    </div>`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: `CruiseMesh <${env.EMAIL_FROM}>`,
      to: purchase.email,
      // A buyer whose setup link failed replies to this message; send them to
      // support instead of an unwatched no-reply address.
      reply_to: "support@cruisemesh.app",
      subject: "Your Cruise Pass is ready",
      text,
      html,
    }),
  });

  // Throw rather than return quietly: fulfill.js clears email_sent_ms on a
  // thrown error, so the next webhook retry or success-page load tries again.
  // Swallowing a rejection here would record a send that never happened.
  if (!response.ok) {
    throw new Error(`Resend rejected the credential email (HTTP ${response.status}): ${await response.text()}`);
  }
}
