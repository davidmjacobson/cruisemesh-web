import { createCheckoutSession, verifyStripeSignature } from "./stripe.js";
import { relaySetupLink } from "./relay.js";
import { fulfillCheckoutSession } from "./fulfill.js";
import { escapeHtml, formatExpiry } from "./email.js";
import { renderSVG } from "uqr";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function page(title, body) {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <meta name="theme-color" content="#fefefd" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#0f151a" media="(prefers-color-scheme: dark)">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="site-header">
    <div class="shell">
      <a class="brand" href="/">
        <svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true">
          <path fill="#fff" stroke="#0e2747" stroke-width="1.2" stroke-linejoin="round" d="M14 45 4 62l23-8Z"/>
          <circle cx="32" cy="30" r="26" fill="#0e2747"/>
          <circle cx="32" cy="30" r="23.5" fill="none" stroke="#fff" stroke-width="5"/>
          <circle cx="32" cy="30" r="25.4" fill="none" stroke="#0e2747" stroke-width="1.2"/>
          <path fill="none" stroke="#a9dcee" stroke-width="2.4" stroke-linecap="round" d="M32 14 20 22M32 14l12 8M32 14v14.5M20 22l12 6.5M44 22l-12 6.5M24 38l8-9.5M40 38l-8-9.5"/>
          <circle cx="32" cy="14" r="3.4" fill="#fff"/>
          <circle cx="20" cy="22" r="3.4" fill="#fff"/>
          <circle cx="44" cy="22" r="3.4" fill="#fff"/>
          <circle cx="32" cy="28.5" r="3.6" fill="#d8f1f8"/>
          <circle cx="24" cy="38" r="3.4" fill="#59cfe4"/>
          <circle cx="40" cy="38" r="3.4" fill="#59cfe4"/>
          <path d="M24.5 40.5 32 35.5l7.5 5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M24 43h16l-3 8.5q-5 2.8-10 0Z" fill="#fff"/>
          <path d="M14 52q10-5.5 19-1t24-3.5" fill="none" stroke="#3fc9de" stroke-width="4" stroke-linecap="round"/>
          <path d="M28 57q9 3.5 19-1.5" fill="none" stroke="#2fb3cf" stroke-width="3" stroke-linecap="round"/>
        </svg>
        CruiseMesh
      </a>
      <nav><a href="/support/">Support</a></nav>
    </div>
  </header>
  <main class="shell">
    <div class="intro">${body}</div>
  </main>
  <footer class="site-footer">
    <div class="shell"><a href="/">Home</a> · <a href="/support/">Support</a></div>
  </footer>
</body>
</html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

async function handleCheckout(request, env) {
  const session = await createCheckoutSession(env, new URL(request.url).origin);
  return json({ url: session.url });
}

async function handleStripeWebhook(request, env) {
  const payload = await request.text();
  const valid = await verifyStripeSignature(payload, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return json({ error: "invalid signature" }, 400);

  const event = JSON.parse(payload);
  // `checkout.session.completed` fires when checkout finishes, but for
  // asynchronous payment methods (some bank debits, vouchers) the money is
  // not captured yet and `payment_status` is still `unpaid` — the real
  // confirmation arrives later as `async_payment_succeeded`. fulfillment
  // itself re-checks payment_status with Stripe, so gating on these two
  // event types (and ignoring async_payment_failed) is the safe set.
  const fulfilWhenPaid =
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded";
  if (fulfilWhenPaid && event.data.object.payment_status === "paid") {
    const purchase = await fulfillCheckoutSession(env, event.data.object.id);
    // `purchase` is null when Stripe no longer reports the session as paid
    // (e.g. the event body raced ahead of a void/refund) — nothing to
    // provision, so ack it and stop retrying. Only a *paid* purchase whose
    // token the relay admin API hasn't accepted yet warrants a 500, which
    // makes Stripe retry (with backoff, for days) until provisioning lands.
    if (purchase && !purchase.provisioned_ms) return json({ error: "provisioning pending" }, 500);
  }
  return json({ received: true });
}

async function handleSuccess(request, env) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) return Response.redirect(`${url.origin}/pass/`, 302);

  const purchase = await fulfillCheckoutSession(env, sessionId);
  if (!purchase) {
    return page(
      "Payment not completed — CruiseMesh",
      `<p class="eyebrow">Cruise Pass</p>
       <h1>Payment not completed.</h1>
       <p class="lede">This checkout has not finished. If you believe you were charged, contact support and we will sort it out.</p>
       <div class="actions"><a class="button" href="/pass/">Try again</a><a class="button secondary" href="/support/">Get help</a></div>`,
    );
  }

  const setupLink = relaySetupLink(url.origin, purchase.relay_url, purchase.family_token);
  const setupCard = setupLink.slice(setupLink.indexOf("#") + 1);
  const setupQr = renderSVG(setupLink, { ecc: "M", border: 4 });
  const emailedNote = purchase.email_sent_ms
    ? `<p>We also emailed everything to <strong>${escapeHtml(purchase.email)}</strong>.</p>`
    : `<p>Save this page or copy the setup card below.</p>`;
  const pendingNote = purchase.provisioned_ms
    ? `<div class="notice success" role="status">Activated and ready to test in CruiseMesh.</div>`
    : `<div class="notice" role="status">Activation is still finishing. This normally takes under a minute; if the app asks you to retry, wait a moment and test again.</div>`;
  const setupCardJson = JSON.stringify(setupCard).replaceAll("<", "\\u003c");

  return page(
    "Your Cruise Pass is ready — CruiseMesh",
    `<p class="eyebrow">Cruise Pass</p>
     <h1>Your Cruise Pass is ready.</h1>
     <p class="lede">Finish setup on a phone with CruiseMesh installed. The app shows the host, tests the connection, and saves it only after you confirm.</p>
     ${pendingNote}
     <div class="actions"><a class="button" href="${escapeHtml(setupLink)}">Open in CruiseMesh</a></div>
     <ol class="setup-steps">
       <li><strong>Open CruiseMesh</strong><span>Tap the button above on the phone you want to set up.</span></li>
       <li><strong>Review</strong><span>Check the host CruiseMesh shows. Your family's token stays hidden.</span></li>
       <li><strong>Test and use</strong><span>CruiseMesh saves the pass only after that check succeeds.</span></li>
     </ol>
     <div class="setup-qr">
       <h2>Set up another phone</h2>
       ${setupQr}
       <p>Scan with the other family phone. This configures internet delivery; it does not add a contact.</p>
     </div>
     <div class="actions secondary-actions">
       <button class="button secondary" id="copy-setup-card" type="button">Copy setup card</button>
       <a class="button secondary" href="/support/">Setup help</a>
     </div>
     <div class="notice" id="copy-notice" role="status" aria-live="polite"></div>
     <details class="manual-setup" id="setup-card-details">
       <summary>Show setup card</summary>
       <div class="token" id="setup-card-text">${escapeHtml(setupCard)}</div>
     </details>
     ${emailedNote}
     <p>Pass active until <strong>${escapeHtml(formatExpiry(purchase.expires_ms))}</strong>. Anyone with this setup card can use your family's internet delivery, so share it only with your own phones.</p>
     <p>If Cruise Pass doesn't work out on your sailing, refunds are no questions asked; see <a href="/support/">support</a>.</p>
     <details class="manual-setup">
       <summary>Custom relay details</summary>
       <p>In CruiseMesh, open <strong>Settings → Cruise Pass → Custom relay</strong>.</p>
       <h2>Relay URL</h2>
       <div class="token">${escapeHtml(purchase.relay_url)}</div>
       <h2>Relay token</h2>
       <div class="token">${escapeHtml(purchase.family_token)}</div>
     </details>
     <script>
       (() => {
         const setupCard = ${setupCardJson};
         document.querySelector("#copy-setup-card").addEventListener("click", async () => {
           const notice = document.querySelector("#copy-notice");
           try {
             await navigator.clipboard.writeText(setupCard);
             notice.textContent = "Setup card copied.";
           } catch {
             const details = document.querySelector("#setup-card-details");
             const card = document.querySelector("#setup-card-text");
             details.open = true;
             const selection = getSelection();
             const range = document.createRange();
             range.selectNodeContents(card);
             selection.removeAllRanges();
             selection.addRange(range);
             notice.textContent = "Select and copy the highlighted setup card.";
           }
         });
       })();
     </script>`,
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/checkout" && request.method === "POST") return await handleCheckout(request, env);
      if (url.pathname === "/api/stripe/webhook" && request.method === "POST") return await handleStripeWebhook(request, env);
      if (url.pathname === "/relay/success" && request.method === "GET") return await handleSuccess(request, env);
    } catch (error) {
      console.error(`${request.method} ${url.pathname} failed: ${error}`);
      return url.pathname.startsWith("/api/")
        ? json({ error: "internal error" }, 500)
        : page("Something went wrong — CruiseMesh", `<h1>Something went wrong.</h1><p class="lede">Please refresh in a moment, or <a href="/support/">contact support</a>.</p>`);
    }
    return env.ASSETS.fetch(request);
  },
};
