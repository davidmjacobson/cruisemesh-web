// Renewing a Cruise Pass: extend the pass a family already has, on the same
// family token, so no phone is set up a second time.
//
// There are no accounts, so ownership is proved the way it was established —
// by the email address that bought the pass. A one-time code is mailed to
// that address and identifies which pass a checkout extends. The code is not
// the family token, is useless to anyone who cannot receive that mail, and
// grants no access to messages: the worst a stolen code can do is let the
// thief pay to extend someone else's pass.
import { PLAN } from "./relay.js";

/// How long an emailed renewal link stays usable. The expiry reminder goes
/// out three days before a pass lapses and people read mail late, so the link
/// has to outlive both that gap and the trip that follows.
export const RENEW_LINK_DAYS = 30;

/// A renewal link email per pass is rate-limited to this, so a form that
/// takes an email address can never be used to flood an inbox. Re-requesting
/// inside the window is answered normally; it just does not send again.
export const RENEW_EMAIL_COOLDOWN_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/// Statuses a pass can carry and still be renewable. 'renewed' is excluded on
/// purpose: that row has already been superseded, and the chain is followed
/// to the live row before anything is extended.
const RENEWABLE = new Set(["active", "refunded"]);

export function generateRenewalCode() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/// The live purchase row for a family: the one with the latest paid-through
/// date among every row sharing the token. Following the chain (rather than
/// trusting the row a code points at) is what keeps a second payment from
/// extending a stale date — two renewals bought from the same emailed link
/// add thirty days each, which is what was paid for.
///
/// Refunded rows sort last regardless of their dates. A refunded renewal can
/// carry a later expiry than the pass that replaced it, and letting it win on
/// date alone would anchor every later resolve, quoted date, and guard
/// comparison to a row whose money was given back — while the relay ran to
/// the real one.
export function livePurchaseForFamily(env, familyToken) {
  return env.DB.prepare(
    `SELECT * FROM purchases
      WHERE family_token = ?1
      ORDER BY (status = 'refunded') ASC, COALESCE(expires_ms, 0) DESC, created_ms DESC
      LIMIT 1`,
  )
    .bind(familyToken)
    .first();
}

/// The most recent pass bought by an address, if it can be renewed. A buyer
/// with two separate families gets the newer one; the link email names its
/// dates so a mistake is visible before any money moves.
///
/// Matched case-insensitively. Addresses are stored lowercased now, but rows
/// written before that carry whatever case Stripe reported, and `=` in SQLite
/// is case-sensitive — a buyer who typed `John@Example.com` at checkout would
/// otherwise be told a link was sent, forever, while nothing ever arrived.
/// This gives up the `purchases_email` index; at this table's size that costs
/// nothing, and correctness here is the difference between a working feature
/// and a silent dead end.
export async function renewablePurchaseForEmail(env, email) {
  const purchase = await env.DB.prepare(
    `SELECT * FROM purchases
      WHERE lower(email) = lower(?1) AND status <> 'renewed'
      ORDER BY created_ms DESC
      LIMIT 1`,
  )
    .bind(email)
    .first();
  if (!purchase || !RENEWABLE.has(purchase.status)) return null;
  return livePurchaseForFamily(env, purchase.family_token);
}

/// Mint a renewal code, or reuse the freshest unredeemed one for this pass.
/// Returns { code, shouldSend }: `shouldSend` is false when a link for this
/// pass was mailed inside the cooldown, which is how repeated requests stay
/// harmless.
export async function issueRenewalCode(env, purchase, nowMs = Date.now()) {
  const existing = await env.DB.prepare(
    `SELECT * FROM renewals
      WHERE session_id = ?1 AND redeemed_ms IS NULL AND expires_ms > ?2
      ORDER BY created_ms DESC
      LIMIT 1`,
  )
    .bind(purchase.session_id, nowMs)
    .first();

  if (existing) {
    const recentlySent = existing.sent_ms && nowMs - existing.sent_ms < RENEW_EMAIL_COOLDOWN_MS;
    return { code: existing.code, shouldSend: !recentlySent };
  }

  const code = generateRenewalCode();
  await env.DB.prepare(
    "INSERT INTO renewals (code, session_id, created_ms, expires_ms) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(code, purchase.session_id, nowMs, nowMs + RENEW_LINK_DAYS * DAY_MS)
    .run();
  return { code, shouldSend: true };
}

export function markRenewalCodeSent(env, code, nowMs = Date.now()) {
  return env.DB.prepare("UPDATE renewals SET sent_ms = ?1 WHERE code = ?2").bind(nowMs, code).run();
}

/// Resolve an emailed code to the pass it renews, or null for anything that
/// is unknown, expired, or points at a purchase that has since vanished.
/// Callers must not tell the two apart: one message for every bad code.
export async function resolveRenewalCode(env, code, nowMs = Date.now()) {
  if (!code || typeof code !== "string" || !/^[0-9a-f]{48}$/.test(code)) return null;
  const renewal = await env.DB.prepare(
    "SELECT * FROM renewals WHERE code = ?1 AND expires_ms > ?2",
  )
    .bind(code, nowMs)
    .first();
  if (!renewal) return null;
  const origin = await env.DB.prepare("SELECT * FROM purchases WHERE session_id = ?1")
    .bind(renewal.session_id)
    .first();
  if (!origin) return null;
  const purchase = await livePurchaseForFamily(env, origin.family_token);
  if (!purchase) return null;
  return { renewal, purchase };
}

/// Fallback for a checkout whose code has expired between the click and the
/// payment — a real gap for asynchronous payment methods, which settle days
/// later. The checkout also carries the purchase id it was started from, and
/// that never expires, so the pass can still be found and extended instead of
/// the customer being handed a new token they must set up everywhere. It is a
/// Stripe session id, not a credential: it identifies a row, and reaching it
/// still requires the admin API or this Worker.
export async function renewalTargetForSession(env, sessionId) {
  if (!sessionId || typeof sessionId !== "string") return null;
  const origin = await env.DB.prepare("SELECT * FROM purchases WHERE session_id = ?1")
    .bind(sessionId)
    .first();
  if (!origin) return null;
  return livePurchaseForFamily(env, origin.family_token);
}

/// Renewing early must never cost days: the new term starts where the old one
/// ends, unless the pass already lapsed, in which case it starts now.
export function extendedExpiry(currentExpiryMs, nowMs = Date.now()) {
  const base = Math.max(nowMs, currentExpiryMs ?? 0);
  return base + PLAN.days * DAY_MS;
}

/// The date a renewal of this pass extends from. Refunded time is not paid
/// time: a pass bought, refunded on day 5, then renewed must not hand back the
/// twenty-five days that were given back as money, which would make $9.99 buy
/// a refund plus a free month. Everything else extends from its paid-through
/// date, so renewing early costs no days.
export function extensionBase(purchase) {
  return purchase.status === "refunded" ? null : purchase.expires_ms;
}

/// Show a buyer which address holds the pass without printing it in full:
/// the renewal page is reachable by anyone holding the link.
export function maskEmail(email) {
  const at = String(email).lastIndexOf("@");
  if (at <= 0) return "your email";
  const name = email.slice(0, at);
  const domain = email.slice(at);
  const head = name.slice(0, name.length <= 2 ? 1 : 2);
  return `${head}${"•".repeat(Math.max(3, name.length - head.length))}${domain}`;
}
