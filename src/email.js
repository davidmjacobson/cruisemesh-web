export function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function sendCredentialEmail(env, purchase, setupLink) {
  const expiry = purchase.expires_ms ? new Date(purchase.expires_ms).toUTCString() : "never";
  const text = [
    "Your Cruise Pass is ready.",
    "",
    "1. Choose Open in CruiseMesh on the phone you want to set up:",
    setupLink,
    "2. Review the relay host shown by the app.",
    "3. Choose Test and use. CruiseMesh saves the pass only after it verifies the relay.",
    "Setup links require CruiseMesh 1.0.2 or later.",
    "",
    "If the setup link did not open, copy the CMRELAY1 card from the end of the link, then open Settings -> Cruise Pass in CruiseMesh and paste it.",
    "",
    "Custom relay details (Settings -> Cruise Pass -> Custom relay):",
    `  Relay URL:   ${purchase.relay_url}`,
    `  Relay token: ${purchase.family_token}`,
    "",
    "One pass covers your whole family, but each family phone needs this setup. After the first phone is ready, use Set up another phone or Show setup QR in Settings -> Cruise Pass.",
    "Cruise Pass setup does not add contacts or give another phone internet access.",
    "",
    `Pass expires: ${expiry}`,
    "",
    "Treat the relay token like a household shared secret. Need help? https://cruisemesh.app/support/",
  ].join("\n");

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#12211d;line-height:1.6">
      <h1 style="font-size:1.4rem">Your Cruise Pass is ready</h1>
      <p><a href="${escapeHtml(setupLink)}" style="display:inline-block;padding:12px 20px;border-radius:12px;background:#087f68;color:#fff;text-decoration:none;font-weight:700">Open in CruiseMesh</a></p>
      <ol>
        <li>Choose <strong>Open in CruiseMesh</strong> above.</li>
        <li>Review the relay host shown by the app.</li>
        <li>Choose <strong>Test and use</strong>. CruiseMesh saves the pass only after verification.</li>
      </ol>
      <p>Setup links require <strong>CruiseMesh 1.0.2 or later</strong>.</p>
      <p>If the link did not open, copy the <code>CMRELAY1</code> card from the end of it, then open <strong>Settings &rarr; Cruise Pass</strong> in CruiseMesh and paste it.</p>
      <p>For a custom relay, open <strong>Settings &rarr; Cruise Pass &rarr; Custom relay</strong>:</p>
      <p style="font-family:monospace;background:#f0f5f3;padding:12px;border-radius:8px;word-break:break-all">
        Relay URL: ${escapeHtml(purchase.relay_url)}<br>
        Relay token: ${escapeHtml(purchase.family_token)}
      </p>
      <p>One pass covers your whole family, but each family phone needs this setup. After the first phone is ready, use <strong>Set up another phone</strong> or <strong>Show setup QR</strong> in Settings &rarr; Cruise Pass.</p>
      <p>Cruise Pass setup does not add contacts or give another phone internet access.</p>
      <p>Pass expires: ${escapeHtml(expiry)}</p>
      <p style="color:#5c6e68;font-size:0.9rem">Treat the relay token like a household shared secret. Questions? <a href="https://cruisemesh.app/support/">cruisemesh.app/support</a></p>
    </div>`;

  await env.EMAIL.send({
    to: purchase.email,
    from: { email: env.EMAIL_FROM, name: "CruiseMesh" },
    subject: "Your Cruise Pass is ready",
    text,
    html,
  });
}
