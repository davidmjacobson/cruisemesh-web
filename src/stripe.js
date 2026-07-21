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
    throw new Error(`Stripe ${method} ${path} failed (${response.status}): ${body?.error?.message ?? "unknown error"}`);
  }
  return body;
}

export function createCheckoutSession(env, origin) {
  return stripeRequest(env, "POST", "/checkout/sessions", {
    mode: "payment",
    "line_items[0]": { price: env.STRIPE_PRICE_ID, quantity: 1 },
    success_url: `${origin}/relay/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/pass/?canceled=1`,
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
