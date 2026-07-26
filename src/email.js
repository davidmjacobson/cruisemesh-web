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
