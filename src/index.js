import { createCheckoutSession, verifyStripeSignature } from "./stripe.js";
import { relaySetupLink } from "./relay.js";
import { fulfillCheckoutSession } from "./fulfill.js";
import { escapeHtml } from "./email.js";

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
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="site-header">
    <div class="shell">
      <a class="brand" href="/">CruiseMesh</a>
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
  const emailedNote = purchase.email_sent_ms
    ? `<p>We also emailed everything to <strong>${escapeHtml(purchase.email)}</strong>.</p>`
    : `<p>Save this page — keep your relay token somewhere safe.</p>`;
  const pendingNote = purchase.provisioned_ms
    ? ""
    : `<div class="notice" role="status">Your relay is still being activated — this normally takes under a minute. The token below will start working automatically.</div>`;

  return page(
    "Your relay is ready — CruiseMesh",
    `<p class="eyebrow">Cruise Pass</p>
     <h1>Your relay is ready.</h1>
     <p class="lede">Open the setup link on a phone with CruiseMesh installed, or copy the details into <strong>Settings → Internet relay</strong>. Sharing friend cards spreads the relay to your whole family automatically.</p>
     ${pendingNote}
     <div class="actions"><a class="button" href="${escapeHtml(setupLink)}">Set up on this phone</a></div>
     <h2 style="margin-top:28px">Relay URL</h2>
     <div class="token">${escapeHtml(purchase.relay_url)}</div>
     <h2 style="margin-top:20px">Relay token</h2>
     <div class="token">${escapeHtml(purchase.family_token)}</div>
     ${emailedNote}
     <p>Pass active until <strong>${escapeHtml(new Date(purchase.expires_ms).toUTCString())}</strong>. Treat the token like a household shared secret.</p>
     <p>If Cruise Pass doesn't work out on your sailing, refunds are no questions asked — see <a href="/support/">support</a>.</p>`,
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
