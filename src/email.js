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
    "Your CruiseMesh relay pass is ready.",
    "",
    `Fastest setup: open this link on a phone with CruiseMesh installed:`,
    setupLink,
    "",
    "Manual setup (Settings -> Internet relay):",
    `  Relay URL:   ${purchase.relay_url}`,
    `  Relay token: ${purchase.family_token}`,
    "",
    `Your pass covers your whole family: once your phone is configured, the relay is shared automatically through the friend cards you exchange.`,
    "",
    `Pass expires: ${expiry}`,
    "",
    "Treat the relay token like a household shared secret. Need help? https://cruisemesh.app/support/",
  ].join("\n");

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#12211d;line-height:1.6">
      <h1 style="font-size:1.4rem">Your CruiseMesh relay pass is ready</h1>
      <p><a href="${escapeHtml(setupLink)}" style="display:inline-block;padding:12px 20px;border-radius:12px;background:#087f68;color:#fff;text-decoration:none;font-weight:700">Open on your phone to set up</a></p>
      <p>Or configure it manually in CruiseMesh under <strong>Settings &rarr; Internet relay</strong>:</p>
      <p style="font-family:monospace;background:#f0f5f3;padding:12px;border-radius:8px;word-break:break-all">
        Relay URL: ${escapeHtml(purchase.relay_url)}<br>
        Relay token: ${escapeHtml(purchase.family_token)}
      </p>
      <p>One pass covers your whole family &mdash; once your phone is configured, the relay is shared automatically through the friend cards you exchange.</p>
      <p>Pass expires: ${escapeHtml(expiry)}</p>
      <p style="color:#5c6e68;font-size:0.9rem">Treat the relay token like a household shared secret. Questions? <a href="https://cruisemesh.app/support/">cruisemesh.app/support</a></p>
    </div>`;

  await env.EMAIL.send({
    to: purchase.email,
    from: { email: env.EMAIL_FROM, name: "CruiseMesh" },
    subject: "Your CruiseMesh relay pass",
    text,
    html,
  });
}
