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

// Where a buyer goes to get another pass. There is no renewal endpoint: a
// second pass is a second checkout, with its own setup card.
const PURCHASE_URL = "https://cruisemesh.app/pass/";

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
  // RENEWAL COPY: a renewal keeps the pass the family already has, so the one
  // thing it must say that buying again cannot is "nothing to set up". Both
  // variants still open with "nothing renews on its own", because that stays
  // true either way — renewing is a payment the buyer chooses, not a
  // subscription. Without RENEW_LINK_SECRET no link can be signed, so the
  // email falls back to the buy-another-pass paragraph rather than offering
  // something this site could not honour.
  const keepGoing = renewUrl
    ? `Nothing renews on its own and you will not be charged again. To keep internet delivery, renew your pass at ${renewUrl}. Renewing keeps the setup card your phones already have, so there is nothing to set up again on any of them: it is the same one-time price, and it adds 30 days to the date above. The link works for 45 days, including after that date.`
    : `Nothing renews on its own and you will not be charged again. To keep internet delivery, buy a new pass at ${PURCHASE_URL}. A new pass comes with a new setup card, and each family phone needs to be set up with that card, the same as the first time.`;
  const keepGoingHtml = renewUrl
    ? `<p>Nothing renews on its own and you will not be charged again. Renewing keeps the setup card your phones already have, so there is nothing to set up again on any of them: it is the same one-time price, and it adds 30 days to the date above. The link works for 45 days, including after that date.</p>
      <p><a href="${escapeHtml(renewUrl)}" style="display:inline-block;padding:12px 20px;border-radius:12px;background:#0d7186;color:#fff;text-decoration:none;font-weight:700">Renew your pass</a></p>`
    : `<p>Nothing renews on its own and you will not be charged again. To keep internet delivery, buy a new pass. A new pass comes with a new setup card, and each family phone needs to be set up with that card, the same as the first time.</p>
      <p><a href="${PURCHASE_URL}" style="display:inline-block;padding:12px 20px;border-radius:12px;background:#0d7186;color:#fff;text-decoration:none;font-weight:700">Buy a new pass</a></p>`;
  const text = [
    `Your Shore Pass expires ${when}.`,
    "",
    `Internet delivery stops on ${expiry}. After that date, CruiseMesh no longer carries your family's messages over the internet.`,
    "",
    "Messaging nearby keeps working without a pass. Phones close to each other still reach one another over Bluetooth and local Wi-Fi, on the ship or ashore, with no internet at all.",
    "",
    keepGoing,
    "",
    "Need help? Reply to this email, or write to support@cruisemesh.app.",
  ].join("\n");

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#1a222a;line-height:1.6">
      <h1 style="font-size:1.4rem">Your Shore Pass expires ${escapeHtml(when)}</h1>
      <p>Internet delivery stops on <strong>${escapeHtml(expiry)}</strong>. After that date, CruiseMesh no longer carries your family's messages over the internet.</p>
      <p>Messaging nearby keeps working without a pass. Phones close to each other still reach one another over Bluetooth and local Wi-Fi, on the ship or ashore, with no internet at all.</p>
      ${keepGoingHtml}
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
      subject: `Your Shore Pass expires ${when}`,
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

// Confirms a renewal to the address already on file (src/fulfill.js). It
// carries no setup card and no token: the family's phones keep the pass they
// have, so re-sending a live credential would be for no reason at all. The new
// date is the whole message.
export async function sendRenewalEmail(env, purchase) {
  const expiry = formatExpiry(purchase.expires_ms);
  const subject = `Your Shore Pass now runs to ${expiry}`;
  const text = [
    "Thank you — your Shore Pass is renewed.",
    "",
    `Internet delivery now runs to ${expiry}.`,
    "",
    "There is nothing to set up. Every phone in your family keeps the pass it already has, and messages carry on going out over the internet as before.",
    "",
    "Need help? Reply to this email, or write to support@cruisemesh.app.",
  ].join("\n");

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#1a222a;line-height:1.6">
      <h1 style="font-size:1.4rem">Your Shore Pass is renewed</h1>
      <p>Internet delivery now runs to <strong>${escapeHtml(expiry)}</strong>.</p>
      <p>There is nothing to set up. Every phone in your family keeps the pass it already has, and messages carry on going out over the internet as before.</p>
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
      subject,
      text,
      html,
    }),
  });
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
    "Your Shore Pass is ready.",
    "",
    "1. Open this link on the phone you want to set up:",
    setupLink,
    "2. Choose Review, and check the host CruiseMesh shows.",
    "3. Choose Test and use. CruiseMesh saves the pass only after that check succeeds.",
    "",
    // TRANSITIONAL: the shipped app still says Cruise Pass on this screen, and
    // the fleet updates at its own pace, so every instruction that names the
    // screen carries both names. Drop the parentheticals once the renamed
    // build has reached the field.
    "If the link did not open CruiseMesh, copy the setup card (the text starting CMRELAY1:) from the end of it, then open Settings -> Shore Pass (called Cruise Pass on older app versions), choose Paste card, then Review.",
    "",
    "One pass covers your whole family, and each family phone needs this setup. Once the first phone is ready, use Set up another phone or Show setup QR in Settings -> Shore Pass.",
    "",
    "Shore Pass sets up internet delivery. It does not add contacts, and it does not share a phone's internet connection.",
    "",
    `Pass expires: ${expiry}`,
    "",
    "Anyone with this link can use your family's internet delivery, so share it only with your own phones.",
    "",
    "Need help? Reply to this email, or write to support@cruisemesh.app.",
    "",
    "Advanced: to enter the details by hand, open Settings -> Shore Pass -> Custom relay.",
    `  Relay URL:   ${purchase.relay_url}`,
    `  Relay token: ${purchase.family_token}`,
  ].join("\n");

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#1a222a;line-height:1.6">
      <h1 style="font-size:1.4rem">Your Shore Pass is ready</h1>
      <p><a href="${escapeHtml(setupLink)}" style="display:inline-block;padding:12px 20px;border-radius:12px;background:#0d7186;color:#fff;text-decoration:none;font-weight:700">Open in CruiseMesh</a></p>
      <ol>
        <li>Tap <strong>Open in CruiseMesh</strong> above, on the phone you want to set up.</li>
        <li>Choose <strong>Review</strong>, and check the host CruiseMesh shows.</li>
        <li>Choose <strong>Test and use</strong>. CruiseMesh saves the pass only after that check succeeds.</li>
      </ol>
      <p>If the link did not open CruiseMesh, copy the setup card (the text starting <code>CMRELAY1:</code>) from the end of it, then open <strong>Settings &rarr; Shore Pass</strong> (called Cruise Pass on older app versions), choose <strong>Paste card</strong>, then <strong>Review</strong>.</p>
      <p>One pass covers your whole family, and each family phone needs this setup. Once the first phone is ready, use <strong>Set up another phone</strong> or <strong>Show setup QR</strong> in Settings &rarr; Shore Pass.</p>
      <p>Shore Pass sets up internet delivery. It does not add contacts, and it does not share a phone's internet connection.</p>
      <p>Pass expires: ${escapeHtml(expiry)}</p>
      <p>Anyone with this link can use your family's internet delivery, so share it only with your own phones.</p>
      <p style="color:#556472;font-size:0.9rem">Need help? Reply to this email, or write to <a href="mailto:support@cruisemesh.app">support@cruisemesh.app</a>.</p>
      <details style="margin-top:20px">
        <summary style="color:#556472;font-size:0.9rem;cursor:pointer">Advanced: enter the details by hand</summary>
        <p style="font-size:0.9rem">In CruiseMesh, open <strong>Settings &rarr; Shore Pass &rarr; Custom relay</strong>.</p>
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
      subject: "Your Shore Pass is ready",
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
