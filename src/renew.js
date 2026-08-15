// Signed renewal links. The expiry-reminder email (src/ops.js) carries one
// per pass; following it starts a fresh Stripe checkout for the same price
// that, once paid, extends the family's existing token instead of minting a
// new one (src/fulfill.js).
//
// The link is a capability: whoever holds it can start a checkout tied to one
// prior purchase. It is deliberately NOT a credential — it never reveals the
// family token, an email address, or whether a purchase exists, and paying
// only ever mails the address already on file. So the signature exists to stop
// strangers pointing checkouts at arbitrary session ids, not to protect a
// secret, and the failure page is the same whatever went wrong.

// 45 days. A reminder goes out 3 days before expiry, but people read email
// late and a lapsed pass can still be renewed (the relay reactivates a
// suspended family on re-provision), so the link has to outlive the pass by a
// comfortable margin rather than expire in the same week the pass does.
export const RENEW_LINK_TTL_MS = 45 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(text) {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

// Hand-rolled rather than crypto.subtle.timingSafeEqual: that one is a Workers
// extension and does not exist in plain Node, where scripts/check.mjs runs
// these paths. Compares every byte regardless of where the first difference
// is, which is the property that matters.
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

// `<base64url(payload JSON)>.<base64url(HMAC-SHA256 of that same text)>`.
// The payload is readable on purpose: it holds a Stripe checkout session id
// the holder already had, and nothing else.
export async function signRenewToken(secret, sessionId, issuedMs = Date.now()) {
  if (!secret) throw new Error("RENEW_LINK_SECRET is not configured");
  const payload = base64UrlEncode(
    encoder.encode(JSON.stringify({ v: 1, s: sessionId, iat: issuedMs, exp: issuedMs + RENEW_LINK_TTL_MS })),
  );
  return `${payload}.${base64UrlEncode(await hmac(secret, payload))}`;
}

// Returns the prior session id, or null for anything wrong at all: bad
// signature, tampered payload, expired link, garbage. Callers must render the
// same page for null as for "no such purchase" — see handleRenew.
export async function verifyRenewToken(secret, token, now = Date.now()) {
  if (!secret || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  let provided;
  try {
    provided = base64UrlDecode(signature);
  } catch {
    return null;
  }
  const expected = await hmac(secret, payload);
  if (!constantTimeEqual(provided, expected)) return null;
  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  } catch {
    return null;
  }
  if (claims?.v !== 1 || typeof claims.s !== "string" || !claims.s) return null;
  if (!Number.isFinite(claims.exp) || now > claims.exp) return null;
  return claims.s;
}

export async function renewLink(origin, secret, sessionId, issuedMs = Date.now()) {
  return `${origin}/renew?t=${await signRenewToken(secret, sessionId, issuedMs)}`;
}
