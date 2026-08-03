import { createCheckoutSession, createRenewalCheckoutSession, verifyStripeSignature } from "./stripe.js";
import { PLAN, relaySetupLink } from "./relay.js";
import { fulfillCheckoutSession } from "./fulfill.js";
import { escapeHtml, formatExpiry, renewLink, sendRenewalLinkEmail } from "./email.js";
import {
  extendedExpiry, extensionBase, issueRenewalCode, markRenewalCodeSent, maskEmail,
  renewablePurchaseForEmail, resolveRenewalCode,
} from "./renew.js";
import { EXPIRY_CRON, RECONCILE_CRON, runExpiryReminders, runReconciliation, runUptimeCheck } from "./ops.js";
import { renderSVG } from "uqr";

// dist/_headers covers the static pages, but it does not apply to anything
// this Worker renders itself — including the success page, whose URL carries
// the Stripe session id. Inline scripts are allowed because these pages ship
// one, nothing is loaded cross-origin, and no-referrer keeps the session id
// out of outbound headers. Deliberately one directive tighter than the static
// policy, which also grants media-src for the home page's explainer video:
// nothing the Worker renders embeds media.
const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, "content-type": "application/json" },
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
    {
      headers: {
        ...SECURITY_HEADERS,
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

async function handleCheckout(request, env) {
  const session = await createCheckoutSession(env, new URL(request.url).origin);
  return json({ url: session.url });
}

// Ask for a renewal link. The response never varies: an address with no pass
// and an address with one get the same words, so this cannot be used to find
// out who bought CruiseMesh. Rate limiting lives in issueRenewalCode, which
// declines to send again inside the cooldown while still answering normally.
//
// Identical words are not enough on their own — a known address used to spend
// a Resend round-trip before answering, which times the difference out loud.
// The lookup and the send therefore run in waitUntil, after the response is
// already on its way, so every caller is answered at the same speed.
async function handleRenewRequest(request, env, ctx) {
  const sameForEveryone = json({
    ok: true,
    message: "If that address has a Cruise Pass, we've sent it a link to extend it.",
  });
  let email = "";
  try {
    email = String((await request.json())?.email ?? "").trim().toLowerCase();
  } catch {
    return sameForEveryone;
  }
  if (!email || email.length > 254 || !email.includes("@")) return sameForEveryone;

  const deliver = async () => {
    try {
      const purchase = await renewablePurchaseForEmail(env, email);
      if (!purchase) return;
      if (!env.RESEND_API_KEY) {
        // Nothing else records this: without mail there is no way to deliver a
        // renewal link at all, and the buyer is staring at "check your inbox".
        console.error(`renewal link not sent for ${purchase.session_id}: RESEND_API_KEY is not configured`);
        return;
      }
      const { code, shouldSend } = await issueRenewalCode(env, purchase);
      if (!shouldSend) return;
      await sendRenewalLinkEmail(env, purchase, renewLink(code));
      // Sent first, recorded second: a link recorded as delivered but never
      // sent locks the address out for the length of the cooldown.
      await markRenewalCodeSent(env, code);
    } catch (error) {
      // A failure here must not tell the caller whether the address exists.
      console.error(`renewal link request failed: ${error}`);
    }
  };
  // ctx is absent only if this is ever called outside a fetch handler; await
  // rather than drop the send on the floor.
  if (ctx?.waitUntil) ctx.waitUntil(deliver());
  else await deliver();
  return sameForEveryone;
}

// Start the checkout that extends an existing pass.
async function handleRenewCheckout(request, env) {
  let code = "";
  try {
    code = String((await request.json())?.code ?? "");
  } catch {
    return json({ error: "invalid request" }, 400);
  }
  const renewing = await resolveRenewalCode(env, code);
  if (!renewing) return json({ error: "This renewal link has expired. Request a new one." }, 404);
  const session = await createRenewalCheckoutSession(env, new URL(request.url).origin, {
    code,
    email: renewing.purchase.email,
    sessionId: renewing.purchase.session_id,
  });
  return json({ url: session.url });
}

// The page an emailed renewal link lands on: what is being extended, through
// what date, and one button. Worker-rendered because the answer depends on
// the code; /pass/renew/ without a code is the static request form.
async function handleRenewPage(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const renewing = await resolveRenewalCode(env, code);
  if (!renewing) {
    return page(
      "Renewal link expired — CruiseMesh",
      `<p class="eyebrow">Cruise Pass</p>
       <h1>This renewal link has expired.</h1>
       <p class="lede">Renewal links stop working after a while, and each one belongs to a single pass. Ask for a fresh one and we'll email it to the address that bought the pass.</p>
       <div class="actions"><a class="button" href="/pass/renew/">Email me a new link</a><a class="button secondary" href="/support/">Get help</a></div>`,
    );
  }

  const { purchase } = renewing;
  const now = Date.now();
  // Every date shown here is derived the same way fulfillment derives it —
  // through extensionBase, not raw expires_ms. A refunded pass extends from
  // today, so quoting its old paid-through date would put a number on the
  // payment button that fulfillment deliberately will not honour, and the
  // customer would pay against a promise of up to thirty days it never had.
  const refunded = purchase.status === "refunded";
  const base = extensionBase(purchase);
  const lapsed = base && base <= now;
  const standing = refunded
    ? "This pass was refunded, so internet delivery is not running."
    : lapsed
      ? `Internet delivery stopped on <strong>${escapeHtml(formatExpiry(base))}</strong>.`
      : `Internet delivery runs until <strong>${escapeHtml(formatExpiry(base))}</strong>.`;
  const through = formatExpiry(extendedExpiry(base, now));
  const canceled = url.searchParams.get("canceled")
    ? `<div class="notice" role="status">Checkout canceled. Nothing was charged.</div>`
    : "";

  return page(
    "Extend your Cruise Pass — CruiseMesh",
    `<p class="eyebrow">Cruise Pass</p>
     <h1>Extend your Cruise Pass.</h1>
     <p class="lede">${standing} Extending adds another ${PLAN.days} days and keeps your family's existing setup card, so there is nothing to set up again — every phone you already set up keeps working.</p>
     ${canceled}
     <p class="price">$9.99 <span>· extends to ${escapeHtml(through)} · one payment, no subscription</span></p>
     <div class="actions">
       <button class="button" id="renew" type="button">Extend to ${escapeHtml(through)}</button>
       <a class="button secondary" href="/support/">Get help</a>
     </div>
     <div class="notice" id="notice" role="status" aria-live="polite"></div>
     <p class="footnote">This is the pass bought with <strong>${escapeHtml(maskEmail(purchase.email))}</strong>. Extending early costs no days: the ${PLAN.days} days are added to the date above, not to today. Nothing renews on its own, so you will not be charged again.</p>
     <script>
       (() => {
         const button = document.querySelector("#renew");
         const notice = document.querySelector("#notice");
         button.addEventListener("click", async () => {
           button.disabled = true;
           notice.textContent = "Opening checkout…";
           try {
             const response = await fetch("/api/renew/checkout", {
               method: "POST",
               headers: { "content-type": "application/json" },
               body: JSON.stringify({ code: ${JSON.stringify(code).replaceAll("<", "\\u003c")} }),
             });
             const body = await response.json();
             if (body.url) { location.href = body.url; return; }
             notice.textContent = body.error || "Could not start checkout. Please try again.";
           } catch {
             notice.textContent = "Could not reach checkout. Check your connection and try again.";
           }
           button.disabled = false;
         });
       })();
     </script>`,
  );
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
  const paidStatus = event.data.object.payment_status;
  // "no_payment_required" is a completed $0 checkout via a 100%-off
  // promotion code (friends-and-family passes) — as final as "paid".
  if (fulfilWhenPaid && (paidStatus === "paid" || paidStatus === "no_payment_required")) {
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
  if (!sessionId) {
    return new Response(null, {
      status: 302,
      headers: { ...SECURITY_HEADERS, location: `${url.origin}/pass/` },
    });
  }

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

  // A renewal kept the family token, so the setup steps, the QR, and the
  // "open in CruiseMesh" button all describe work nobody has to do. Showing
  // them anyway is how a renewal turns into a family walking round every
  // phone re-scanning a card that never changed.
  if (purchase.renewed_from) {
    const renewalEmailNote = purchase.email_sent_ms
      ? `<p>We emailed this confirmation to <strong>${escapeHtml(purchase.email)}</strong>.</p>`
      : "";
    return page(
      "Your Cruise Pass is extended — CruiseMesh",
      `<p class="eyebrow">Cruise Pass</p>
       <h1>Extended to ${escapeHtml(formatExpiry(purchase.expires_ms))}.</h1>
       <p class="lede">There is nothing to set up. Your family keeps the same setup card, every phone you already set up keeps working, and internet delivery simply continues.</p>
       ${purchase.provisioned_ms
         ? `<div class="notice success" role="status">Internet delivery is active until ${escapeHtml(formatExpiry(purchase.expires_ms))}.</div>`
         : `<div class="notice" role="status">The new date is still being applied — normally under a minute. Until it lands, the old expiry is still in force, so if your pass had already lapsed, internet delivery resumes when it does.</div>`}
       ${renewalEmailNote}
       <p>Nothing renews on its own, so you will not be charged again. We'll email you a few days before this date.</p>
       <div class="actions"><a class="button secondary" href="/support/">Setup help</a></div>
       <details class="manual-setup">
         <summary>Adding a phone that never had the pass?</summary>
         <p>Open this link on that phone. Anyone with it can use your family's internet delivery, so share it only with your own phones.</p>
         <div class="token">${escapeHtml(setupLink)}</div>
       </details>`,
    );
  }
  // This page is served from cruisemesh.app, and iOS does not fire a Universal
  // Link for a same-domain navigation — so an https link to /r here is inert in
  // Safari, and Chrome declines it too. Mirrors what dist/open-in-app.mjs does
  // for the on-page buttons on /f and /r; check.mjs keeps the two in step. The
  // QR and the credential email keep the https form on purpose: those are read
  // cross-origin, where the Universal Link fires normally.
  const appSetupLink = `cruisemesh://r#${setupCard}`;
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
     <div class="actions"><a class="button" id="open-in-app" href="${escapeHtml(appSetupLink)}">Open in CruiseMesh</a></div>
     <div class="notice" id="open-notice" role="status" aria-live="polite"></div>
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
     </script>
     <script type="module">
       import { armOpenButton } from "/open-in-app.mjs";
       armOpenButton({
         button: document.querySelector("#open-in-app"),
         notice: document.querySelector("#open-notice"),
         message: "CruiseMesh did not open. Check that the app is installed on this phone and up to date, then try again, or copy the setup card below and paste it in Settings → Cruise Pass. Reading this on a computer? Scan the QR code with the phone instead.",
       });
     </script>`,
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Cloudflare answers this Worker on http:// as well as https://, and the
    // "Always Use HTTPS" toggle lives in a dashboard rather than in this repo,
    // so the upgrade is done here where it is reviewable. It matters more here
    // than on most sites: /r renders a family relay token, and the audience is
    // on ship, port, and hotel Wi-Fi — the networks an attacker owns. The ACME
    // path is exempt so an HTTP-01 challenge is never redirected away from a
    // certificate renewal.
    // `wrangler dev` serves plain http on localhost, so exempting it is what
    // keeps this from redirecting local development into a dead https port.
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol === "http:" && !local && !url.pathname.startsWith("/.well-known/acme-challenge/")) {
      url.protocol = "https:";
      return new Response(null, { status: 301, headers: { location: url.toString() } });
    }
    try {
      if (url.pathname === "/api/checkout" && request.method === "POST") return await handleCheckout(request, env);
      if (url.pathname === "/api/renew/request" && request.method === "POST") return await handleRenewRequest(request, env, ctx);
      if (url.pathname === "/api/renew/checkout" && request.method === "POST") return await handleRenewCheckout(request, env);
      // Only a link carrying a code is rendered here; a bare /pass/renew/ is
      // the static page that asks for an address, and falls through to assets.
      if (
        (url.pathname === "/pass/renew" || url.pathname === "/pass/renew/") &&
        request.method === "GET" &&
        url.searchParams.has("code")
      ) {
        return await handleRenewPage(request, env);
      }
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

  // Cron entry point for the ops jobs (wrangler.jsonc `triggers.crons`).
  // The real work lives in ops.js; dispatch on the cron expression so a
  // future third schedule stays a one-line change here.
  async scheduled(controller, env) {
    if (controller.cron === RECONCILE_CRON) return runReconciliation(env);
    if (controller.cron === EXPIRY_CRON) return runExpiryReminders(env);
    return runUptimeCheck(env);
  },
};
