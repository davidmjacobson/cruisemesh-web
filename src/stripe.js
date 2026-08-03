const STRIPE_API = "https://api.stripe.com/v1";
const SIGNATURE_TOLERANCE_SECONDS = 300;

function formEncode(params) {
  const search = new URLSearchParams();
  const add = (key, value) => {
    if (value === undefined || value === null) return;
    if (typeof value === "object") {
      for (const [nested, nestedValue] of Object.entries(value)) add(`${key}[${nested}]`, nestedValue);
    } else {
      search.append(key, String(value));
    }
  };
  for (const [key, value] of Object.entries(params)) add(key, value);
  return search;
}

async function stripeRequest(env, method, path, params) {
  if (!env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY secret is not configured");
  let url = `${STRIPE_API}${path}`;
  const init = { method, headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } };
  if (params && method === "POST") {
    init.headers["content-type"] = "application/x-www-form-urlencoded";
    init.body = formEncode(params).toString();
  } else if (params) {
    url += `?${formEncode(params)}`;
  }
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(
      `Stripe ${method} ${path} failed (${response.status}): ${body?.error?.message ?? "unknown error"}`,
    );
    // Carried so callers can tell "this session id is not a thing" (a
    // mistyped or foreign URL, which deserves friendly copy) from "Stripe is
    // having a bad day" (which deserves a retry and a generic error).
    error.status = response.status;
    error.stripeCode = body?.error?.code ?? null;
    throw error;
  }
  return body;
}

export function createCheckoutSession(env, origin) {
  return stripeRequest(env, "POST", "/checkout/sessions", {
    mode: "payment",
    "line_items[0]": { price: env.STRIPE_PRICE_ID, quantity: 1 },
    // Shows the "Add promotion code" field. Friends-and-family codes are
    // 100% off, which completes checkout with payment_status
    // "no_payment_required" -- fulfillment must accept that status too.
    allow_promotion_codes: true,
    success_url: `${origin}/relay/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/pass/?canceled=1`,
  });
}

// A renewal is the same product at the same price; what makes it a renewal is
// the code in metadata, which fulfillment reads to extend an existing family
// token instead of minting a new one. Metadata rides on the session, so it
// reaches the webhook path as well as the success page.
export function createRenewalCheckoutSession(env, origin, { code, email, sessionId }) {
  return stripeRequest(env, "POST", "/checkout/sessions", {
    mode: "payment",
    "line_items[0]": { price: env.STRIPE_PRICE_ID, quantity: 1 },
    allow_promotion_codes: true,
    // Prefilled for convenience, never trusted: which pass gets extended is
    // resolved from the code, not from whatever address is typed at Stripe.
    customer_email: email || undefined,
    // Two ways to find the pass again at fulfillment. The code can age out
    // between the click and the payment (asynchronous methods settle days
    // later); the purchase id cannot. Neither is a credential — the family
    // token is never sent to Stripe.
    metadata: { renew_code: code, renew_session: sessionId },
    success_url: `${origin}/relay/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/pass/renew/?code=${encodeURIComponent(code)}&canceled=1`,
  });
}

export function getCheckoutSession(env, sessionId) {
  return stripeRequest(env, "GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

// Stripe-Signature verification per https://docs.stripe.com/webhooks#verify-manually:
// header is `t=<unix>,v1=<hmac>,...`; the HMAC-SHA256 of `<t>.<raw body>` keyed by the
// webhook signing secret must match one of the v1 entries, and t must be recent.
export async function verifyStripeSignature(payload, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  let timestamp = null;
  const signatures = [];
  for (const part of signatureHeader.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = Number(value);
    if (key === "v1") signatures.push(value);
  }
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const expected = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expectedBytes = new TextEncoder().encode(expected);
  return signatures.some((candidate) => {
    const candidateBytes = new TextEncoder().encode(candidate);
    return candidateBytes.length === expectedBytes.length && crypto.subtle.timingSafeEqual(candidateBytes, expectedBytes);
  });
}
