import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import redirectWorker from "../src/redirect.js";

const files = [
  "dist/.well-known/assetlinks.json",
  "dist/.well-known/apple-app-site-association",
];

for (const file of files) {
  const parsed = JSON.parse(await readFile(file, "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error(`${file} is not valid JSON`);
}

const friendPage = await readFile("dist/f/index.html", "utf8");
if (!friendPage.includes("location.hash")) {
  throw new Error("Friend page must read the card from the URL fragment");
}
if (friendPage.includes("fetch(")) {
  throw new Error("Friend page must not transmit friend-card fragments");
}
// Regression guard. This page matched only CMFRIEND1 while the app had moved
// to the compact CMFRIEND2 card, so every friend link shared as a link told
// the recipient it contained no card. The page must stay version-agnostic:
// it only displays a card and hands it to the app, which validates it.
const friendCardPattern = friendPage.match(/const CARD = (\/[^/]+\/)/)?.[1];
if (!friendCardPattern) {
  throw new Error("Friend page must define a CARD pattern for the friend-card fragment");
}
const friendCardRe = new RegExp(friendCardPattern.slice(1, -1));
for (const version of ["CMFRIEND1", "CMFRIEND2", "CMFRIEND3"]) {
  const sample = `${version}:abcDEF123_-`;
  if (friendCardRe.exec(sample)?.[0] !== sample) {
    throw new Error(`Friend page must accept ${version} cards (it only hands them to the app)`);
  }
}

const relayPage = await readFile("dist/r/index.html", "utf8");
if (!relayPage.includes("location.hash")) {
  throw new Error("Relay setup page must read the card from the URL fragment");
}
// The setup QR is drawn client-side from the vendored uqr module, so a buyer
// reading the email on a computer can point each phone at the screen without
// the card ever leaving the page.
if (!relayPage.includes('from "/qr.mjs"') || !relayPage.includes("setup-qr")) {
  throw new Error("Relay setup page must render the client-side setup QR");
}
await readFile("dist/qr.mjs");

// Regression guard. Both "Open in CruiseMesh" buttons pointed at this site's
// own https URL, and iOS does not fire a Universal Link for a same-domain
// navigation — so the button was inert in Safari by design, and Chrome
// declined it for the same reason. The buttons must address the app over the
// cruisemesh:// scheme, which fires regardless of the page's origin.
await readFile("dist/open-in-app.mjs");
for (const [name, page, route] of [
  ["Friend", friendPage, "f"],
  ["Relay setup", relayPage, "r"],
]) {
  if (!page.includes('from "/open-in-app.mjs"') || !page.includes(`appLink("${route}"`)) {
    throw new Error(`${name} page must open the app with appLink("${route}", …) from /open-in-app.mjs`);
  }
  if (/#open"\)\s*\.href\s*=\s*(location\.href|"https)/.test(page)) {
    throw new Error(`${name} page must not point "Open in CruiseMesh" at an https link on this same site`);
  }
}

// A pass expires 30 days after *purchase* (src/fulfill.js), not after first
// use and not after sailing. Someone who buys three weeks before the cruise
// loses most of the trip, and the page used to say only "30 days" — so the
// clock's starting point has to stay on the page that takes the money.
const passPage = await readFile("dist/pass/index.html", "utf8");
for (const requiredText of ["30 days from purchase", "start the moment you buy"]) {
  if (!passPage.includes(requiredText)) {
    throw new Error(`Pass page must say when the 30 days start ("${requiredText}")`);
  }
}

const termsPage = await readFile("dist/terms/index.html", "utf8");
for (const requiredText of [
  "Terms version:",
  "Your content and conduct",
  "Messaging safety, blocking, and reporting",
  "abuse@cruisemesh.app",
  "/privacy/",
]) {
  if (!termsPage.includes(requiredText)) {
    throw new Error(`Terms page must include ${requiredText}`);
  }
}
if (relayPage.includes("fetch(")) {
  throw new Error("Relay setup page must not transmit relay-card fragments");
}

const worker = (await import("../src/index.js")).default;
if (typeof worker.fetch !== "function") {
  throw new Error("Site worker must export a fetch handler");
}
if (typeof worker.scheduled !== "function") {
  throw new Error("Site worker must export a scheduled handler (uptime, reconciliation, expiry-reminder crons)");
}
// Byte ranges. iOS Safari opens a video with a small probe range and gives up
// on the element unless the answer is a 206, so an unseekable file is an
// unplayable one on the phones this site is aimed at. The Asset Worker does
// not answer Range — it returns the whole body with a 200 — so src/index.js
// answers it, and this pins that behaviour down. A stub stands in for the
// ASSETS binding; the point is the Worker's range arithmetic, not Cloudflare's.
const rangeBody = new Uint8Array(1000).map((_, i) => i % 256);
const stubAssets = {
  fetch: async () =>
    new Response(rangeBody, {
      status: 200,
      headers: { "content-type": "video/mp4", etag: '"whole-file"' },
    }),
};
const rangeRequest = (value) =>
  worker.fetch(new Request("https://cruisemesh.app/cruisemesh-explainer.mp4", { headers: { range: value } }), {
    ASSETS: stubAssets,
  });

for (const [header, status, contentRange, length] of [
  ["bytes=0-1", 206, "bytes 0-1/1000", 2],
  ["bytes=100-199", 206, "bytes 100-199/1000", 100],
  ["bytes=900-", 206, "bytes 900-999/1000", 100],
  ["bytes=-50", 206, "bytes 950-999/1000", 50],
  ["bytes=5000-", 416, "bytes */1000", null],
]) {
  const response = await rangeRequest(header);
  if (response.status !== status) {
    throw new Error(`Range "${header}" must answer ${status}, got ${response.status}`);
  }
  if (response.headers.get("content-range") !== contentRange) {
    throw new Error(`Range "${header}" must report "${contentRange}", got "${response.headers.get("content-range")}"`);
  }
  if (response.headers.get("etag")) {
    throw new Error(`Range "${header}" must not keep the whole file's ETag on a partial body`);
  }
  if (length !== null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== length) throw new Error(`Range "${header}" must return ${length} bytes, got ${bytes.length}`);
    const [start] = contentRange.slice("bytes ".length).split("-").map(Number);
    if (!bytes.every((byte, i) => byte === rangeBody[start + i])) {
      throw new Error(`Range "${header}" returned the wrong slice of the file`);
    }
  }
}
// A player that sees no Accept-Ranges may never ask for a range at all.
const wholeFile = await worker.fetch(new Request("https://cruisemesh.app/cruisemesh-explainer.mp4"), {
  ASSETS: stubAssets,
});
if (wholeFile.headers.get("accept-ranges") !== "bytes") {
  throw new Error("Asset responses must advertise Accept-Ranges: bytes");
}

const { relaySetupToken } = await import("../src/relay.js");
const setupToken = relaySetupToken("https://relay.example", "abc123");
if (!/^CMRELAY1:[A-Za-z0-9_-]+$/.test(setupToken)) {
  throw new Error("Relay setup tokens must be fragment-safe base64url");
}
const goldenSetupToken = "CMRELAY1:eyJ2IjoxLCJyZWxheV91cmwiOiJodHRwczovL3JlbGF5LmV4YW1wbGUiLCJyZWxheV90b2tlbiI6ImFiYzEyMyJ9";
if (setupToken !== goldenSetupToken) {
  throw new Error("Relay setup token no longer matches the mobile golden vector");
}
const setupPayload = JSON.parse(Buffer.from(setupToken.slice("CMRELAY1:".length), "base64url").toString("utf8"));
if (setupPayload.v !== 1 || setupPayload.relay_url !== "https://relay.example" || setupPayload.relay_token !== "abc123") {
  throw new Error("Relay setup token payload does not round-trip");
}

const association = JSON.parse(await readFile("dist/.well-known/apple-app-site-association", "utf8"));
const associatedPaths = association.applinks.details.flatMap((detail) => detail.components.map((component) => component["/"]));
for (const path of ["/f", "/f/", "/r", "/r/"]) {
  if (!associatedPaths.includes(path)) throw new Error(`Universal Links must include ${path}`);
}

const supportPage = await readFile("dist/support/index.html", "utf8");
if (supportPage.includes("Settings → Internet relay")) {
  throw new Error("Support must not reference the retired Internet relay screen");
}
for (const requiredText of ["Settings → Shore Pass", "Connection details", "Test and use"]) {
  if (!supportPage.includes(requiredText)) throw new Error(`Support must include ${requiredText}`);
}
for (const requiredText of ["Save and check later", "Show setup QR"]) {
  if (!supportPage.includes(requiredText) && !(await readFile("src/email.js", "utf8")).includes(requiredText)) {
    throw new Error(`Public setup instructions must include ${requiredText}`);
  }
}

// Buyer-facing setup copy has to track the app. CP3 (#156) confined relay
// wording to the Custom relay section, and the setup-card flow's button is
// "Test and use" — "Test and save" belongs to Custom relay and sends people
// looking for a button that is not on their screen. Version gating is gone
// because every shipped build is now 1.0.2 or later.
for (const file of ["src/email.js", "src/index.js", "dist/r/index.html"]) {
  const source = await readFile(file, "utf8");
  for (const banned of ["1.0.2", "relay host", "relay mailbox", "household"]) {
    if (source.includes(banned)) throw new Error(`${file} must not use buyer-facing copy "${banned}"`);
  }
  if (!source.includes("Test and use")) throw new Error(`${file} must name the app's Test and use button`);
}

// Paying customers must never be sent to a public issue tracker to get help:
// support requests carry checkout emails and purchase details.
for (const page of ["support", "terms", "privacy"]) {
  const html = await readFile(`dist/${page}/index.html`, "utf8");
  if (html.includes("github.com/davidmjacobson/cruisemesh/issues")) {
    throw new Error(`${page} must not route support to the public issue tracker`);
  }
  if (!html.includes("mailto:support@cruisemesh.app")) {
    throw new Error(`${page} must offer support@cruisemesh.app as the contact channel`);
  }
}

// The asset router answers HTML navigation requests itself unless the Worker
// runs first, which silently turns the post-checkout success page into
// dist/404.html for real browsers while curl and the Stripe webhook (a POST)
// both still pass. Nothing else catches this.
// It is now a rule list rather than `true`, because the mp4 has to reach the
// Asset Worker to get byte-range support. That is a narrow, deliberate hole:
// anything else added to the exclusion list would take the Worker off a path
// it is load-bearing for, so the allowed exclusions are named here.
const wranglerConfig = await readFile("wrangler.jsonc", "utf8");
const workerFirst = /"run_worker_first"\s*:\s*(true|\[[^\]]*\])/.exec(wranglerConfig);
if (!workerFirst) {
  throw new Error("assets.run_worker_first is missing; buyers returning from Stripe would get the 404 page");
}
if (workerFirst[1] !== "true") {
  const rules = [...workerFirst[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (!rules.includes("/*")) {
    throw new Error('assets.run_worker_first must still match "/*", or /relay/success stops reaching the Worker');
  }
  const allowed = new Set(["!/cruisemesh-explainer.mp4"]);
  for (const rule of rules.filter((r) => r.startsWith("!"))) {
    if (!allowed.has(rule)) {
      throw new Error(`assets.run_worker_first excludes ${rule} from the Worker; add it here deliberately or drop it`);
    }
  }
}

// The scheduled handler dispatches on the literal cron expression, and every
// expression it does not recognize falls through to the uptime probe — so a
// cron string that drifts between wrangler.jsonc and ops.js silently runs
// the wrong job instead of failing.
const { UPTIME_CRON, RECONCILE_CRON, EXPIRY_CRON } = await import("../src/ops.js");
for (const cron of [UPTIME_CRON, RECONCILE_CRON, EXPIRY_CRON]) {
  if (!wranglerConfig.includes(`"${cron}"`)) {
    throw new Error(`wrangler.jsonc must declare the "${cron}" cron trigger ops.js dispatches on`);
  }
}
// Cloudflare applies *every* _headers rule that matches a request, so a header
// named in both /* and a path-specific block is sent twice — which is how /f
// and /r came to answer with two conflicting Referrer-Policy values. The
// site-wide values therefore live in /* alone.
const headersFile = await readFile("dist/_headers", "utf8");
const headerRules = new Map();
let currentRule = null;
for (const line of headersFile.split("\n")) {
  if (!line.trim() || line.trim().startsWith("#")) continue;
  if (!/^\s/.test(line)) {
    currentRule = line.trim();
    headerRules.set(currentRule, []);
  } else if (currentRule) {
    headerRules.get(currentRule).push(line.slice(0, line.indexOf(":")).trim().toLowerCase());
  }
}
const globalHeaders = headerRules.get("/*") ?? [];
for (const required of ["strict-transport-security", "content-security-policy", "referrer-policy", "x-content-type-options"]) {
  if (!globalHeaders.includes(required)) {
    throw new Error(`dist/_headers must set ${required} on /* so every page gets it`);
  }
}
for (const [rule, names] of headerRules) {
  if (rule === "/*") continue;
  for (const name of names) {
    if (globalHeaders.includes(name)) {
      throw new Error(`dist/_headers sets ${name} in both /* and ${rule}; both rules apply, so it is sent twice`);
    }
  }
}

// The explainer video. A <video> whose source 404s fails silently — the poster
// sits there and the play button does nothing — so assert every referenced file
// exists. media-src is its own directive: without it the video is blocked by
// default-src even though the file is right there, and only the browser console
// says so.
const home = await readFile("dist/index.html", "utf8");
for (const asset of ["/cruisemesh-explainer.mp4", "/explainer-poster.jpg", "/explainer-captions.vtt"]) {
  if (!home.includes(asset)) {
    throw new Error(`dist/index.html no longer references ${asset}`);
  }
  if (!existsSync(`dist${asset}`)) {
    throw new Error(`dist/index.html references ${asset}, which does not exist`);
  }
}
if (!headersFile.includes("media-src 'self'")) {
  throw new Error("dist/_headers CSP must grant media-src 'self' or the explainer video is blocked");
}
// Cloudflare's asset upload rejects anything over 25 MiB.
const videoBytes = (await stat("dist/cruisemesh-explainer.mp4")).size;
if (videoBytes > 25 * 1024 * 1024) {
  throw new Error(`dist/cruisemesh-explainer.mp4 is ${(videoBytes / 1024 / 1024).toFixed(1)} MiB; Cloudflare rejects assets over 25 MiB`);
}
// A .vtt without this first line is discarded outright by every browser.
const captions = await readFile("dist/explainer-captions.vtt", "utf8");
if (!captions.startsWith("WEBVTT")) {
  throw new Error("dist/explainer-captions.vtt must begin with the WEBVTT signature");
}

// The only robots.txt ever served was Cloudflare's Content Signals preamble:
// comments announcing that access is conditional on signals, followed by no
// signals and no directives at all.
const robots = await readFile("dist/robots.txt", "utf8");
if (!robots.includes("Content-Signal:") || !/^User-Agent:/m.test(robots)) {
  throw new Error("robots.txt must carry real directives, not just the Content Signals preamble");
}
if (!robots.includes("Sitemap: https://cruisemesh.app/sitemap.xml")) {
  throw new Error("robots.txt must point at the sitemap");
}
for (const private_ of ["/f/", "/r/", "/relay/"]) {
  if (!robots.includes(`Disallow: ${private_}`)) {
    throw new Error(`robots.txt must keep crawlers off ${private_}`);
  }
}

// Family tokens are the credential; ops email must only ever carry the same
// 12-character prefix relay_admin.sh prints.
const opsSource = await readFile("src/ops.js", "utf8");
if (!opsSource.includes("tokenPrefix(")) {
  throw new Error("Ops emails must truncate family tokens via tokenPrefix()");
}

const workerSource = await readFile("src/index.js", "utf8");
for (const requiredText of ["Open in CruiseMesh", "Test and use", "Copy setup card", "Set up another phone", "Custom relay details"]) {
  if (!workerSource.includes(requiredText)) throw new Error(`Purchase success flow must include ${requiredText}`);
}
if (!workerSource.includes("renderSVG") || !workerSource.includes("setup-qr")) {
  throw new Error("Purchase success flow must render an in-page second-phone setup QR");
}
// Same trap the /f and /r pages fell into, one page later: the success page is
// itself served from cruisemesh.app, so an https link to /r is a same-domain
// navigation, and iOS does not fire a Universal Link for one. That made the
// first tap after paying — the highest-stakes tap in the funnel — inert. The
// QR and the credential email stay https on purpose; they are read
// cross-origin, where the Universal Link fires normally.
if (!workerSource.includes("cruisemesh://r#")) {
  throw new Error("Purchase success page must open the app over cruisemesh://, not an https link to this same site");
}
if (/id="open-in-app"[^>]*setupLink/.test(workerSource)) {
  throw new Error("Purchase success page must not point its open button at the https setup link");
}
if (!workerSource.includes("armOpenButton")) {
  throw new Error("Purchase success page must arm the did-it-open fallback from /open-in-app.mjs");
}
// Cloudflare answers this Worker on http:// too, and the "Always Use HTTPS"
// toggle is not in this repo. /r renders a family relay token to an audience
// on ship and hotel Wi-Fi, so the upgrade has to be in code where it is
// reviewable — and it did not exist at all until 2026-08-01.
if (!workerSource.includes('url.protocol === "http:"')) {
  throw new Error("Worker must redirect http:// to https:// (the site answered plaintext http with 200)");
}
if (!workerSource.includes("strict-transport-security")) {
  throw new Error("Worker-rendered pages must carry the security headers dist/_headers cannot reach");
}
// Friends-and-family passes redeem a 100%-off promotion code, which
// completes checkout as "no_payment_required" instead of "paid". If either
// fulfillment gate stops accepting it, free passes silently show buyers the
// "Payment not completed" page.
const stripeSource = await readFile("src/stripe.js", "utf8");
if (!stripeSource.includes("allow_promotion_codes")) {
  throw new Error("Checkout must allow promotion codes (friends-and-family passes)");
}
for (const file of ["src/fulfill.js", "src/index.js"]) {
  if (!(await readFile(file, "utf8")).includes("no_payment_required")) {
    throw new Error(`${file} must accept no_payment_required (100%-off promotion codes)`);
  }
}

const emailSource = await readFile("src/email.js", "utf8");
if (!emailSource.includes("each family phone needs this setup")) {
  throw new Error("Credential email must explain that every family phone needs setup");
}
if (emailSource.includes("shared automatically through the friend cards")) {
  throw new Error("Credential email must not imply that friend cards configure Shore Pass");
}

// The expiring-pass reminder. Renewing is now possible, but only as a payment
// the buyer chooses: nothing bills them on its own, and a buyer who believed
// otherwise would sail with nothing. The email also has to say what still
// works without a pass, or it reads as "CruiseMesh stops working". The
// purchase page stays in the source as the fallback for a reminder sent while
// no renewal link can be signed.
if (!emailSource.includes("https://cruisemesh.app/pass/")) {
  throw new Error("Expiry reminder must keep the purchase page as its fallback");
}
for (const banned of ["renews automatically", "auto-renew", "renews itself", "charged automatically"]) {
  if (emailSource.toLowerCase().includes(banned.toLowerCase())) {
    throw new Error(`Expiry reminder must not imply automatic billing ("${banned}")`);
  }
}
for (const requiredText of ["Nothing renews on its own", "Bluetooth and local Wi-Fi", "each family phone needs to be set up"]) {
  if (!emailSource.includes(requiredText)) {
    throw new Error(`Expiry reminder must say "${requiredText}"`);
  }
}
const { daysUntil } = await import("../src/email.js");
const day = 24 * 60 * 60 * 1000;
for (const [aheadMs, expected] of [[3 * day, "in 3 days"], [2.5 * day, "in 3 days"], [day, "tomorrow"], [0, "today"]]) {
  if (daysUntil(aheadMs, 0) !== expected) {
    throw new Error(`Expiry reminder must describe ${aheadMs / day} days ahead as "${expected}"`);
  }
}
// The reminder window is wider than the cron interval, so without a record of
// which expiry was reminded about, every buyer gets the same email three days
// running (plus one per cron retry).
if (!opsSource.includes("expiry_reminded_for_ms")) {
  throw new Error("Expiry reminders must record the expiry they were sent for, or they repeat daily");
}
if (!(await readFile("migrations/0003_expiry_reminder.sql", "utf8")).includes("expiry_reminded_for_ms")) {
  throw new Error("migrations must add the expiry_reminded_for_ms column src/ops.js writes");
}
if (!(await readFile("migrations/0004_renewals.sql", "utf8")).includes("renewal_of")) {
  throw new Error("migrations must add the renewal_of column fulfillment writes");
}

// --- Renewals --------------------------------------------------------------

const { signRenewToken, verifyRenewToken, renewLink, RENEW_LINK_TTL_MS } = await import("../src/renew.js");
const { fulfillCheckoutSession } = await import("../src/fulfill.js");
const { runExpiryReminders } = await import("../src/ops.js");

// Renewal links are signed with RENEW_LINK_SECRET. They are not credentials,
// but they do decide which purchase a checkout attaches to, so a stranger must
// not be able to invent one, edit the purchase out of one, or use one forever.
{
  const secret = "renew-secret";
  const issued = Date.UTC(2026, 8, 1);
  const token = await signRenewToken(secret, "cs_prior", issued);

  if (RENEW_LINK_TTL_MS !== 45 * day) {
    throw new Error("Renewal links are described to the buyer as lasting 45 days");
  }
  if ((await verifyRenewToken(secret, token, issued + 1000)) !== "cs_prior") {
    throw new Error("A freshly signed renewal link must verify");
  }
  // The reminder goes out days before expiry and people read email late, so a
  // link found a month after the pass lapsed still has to work.
  if ((await verifyRenewToken(secret, token, issued + 40 * day)) !== "cs_prior") {
    throw new Error("A renewal link must outlive the pass it renews");
  }
  if ((await verifyRenewToken(secret, token, issued + RENEW_LINK_TTL_MS + 1)) !== null) {
    throw new Error("An expired renewal link must not verify");
  }
  if ((await verifyRenewToken("a-different-secret", token, issued + 1000)) !== null) {
    throw new Error("A renewal link signed with another secret must not verify");
  }
  const [payload, signature] = token.split(".");
  const swapped = Buffer.from(
    JSON.stringify({ v: 1, s: "cs_someone_elses_purchase", iat: issued, exp: issued + RENEW_LINK_TTL_MS }),
  ).toString("base64url");
  if ((await verifyRenewToken(secret, `${swapped}.${signature}`, issued + 1000)) !== null) {
    throw new Error("Editing the purchase out of a renewal link must not verify");
  }
  const flipped = signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A");
  if ((await verifyRenewToken(secret, `${payload}.${flipped}`, issued + 1000)) !== null) {
    throw new Error("A renewal link with a changed signature must not verify");
  }
  for (const nonsense of ["", "abc", "abc.", ".abc", "not-a-token", `${payload}.`]) {
    if ((await verifyRenewToken(secret, nonsense, issued + 1000)) !== null) {
      throw new Error(`A malformed renewal link must not verify (${nonsense})`);
    }
  }
  if ((await verifyRenewToken(undefined, token, issued + 1000)) !== null) {
    throw new Error("With no signing secret configured, no renewal link may verify");
  }
  if (!(await renewLink("https://cruisemesh.app", secret, "cs_prior", issued)).startsWith("https://cruisemesh.app/renew?t=")) {
    throw new Error("Renewal links must point at /renew on the live site");
  }
}

// A stand-in for the purchases table: enough of D1's prepare/bind/first/all/run
// shape to run the reminder cron, the renew endpoint and fulfillment for real,
// against rows this file controls.
function purchasesDb(rows) {
  return {
    prepare(sql) {
      const bound = { params: [] };
      const find = (sessionId) => rows.find((row) => row.session_id === sessionId);
      return {
        bind(...params) {
          bound.params = params;
          return this;
        },
        first: async () => find(bound.params[0]) ?? null,
        all: async () => {
          if (!sql.includes("WHERE status = 'active'")) return { results: rows.slice() };
          const [from, to] = bound.params;
          return {
            results: rows.filter(
              (row) =>
                row.status === "active" &&
                row.email &&
                row.provisioned_ms &&
                row.expires_ms > from &&
                row.expires_ms <= to &&
                row.expiry_reminded_for_ms !== row.expires_ms,
            ),
          };
        },
        run: async () => {
          if (sql.includes("INSERT INTO purchases")) {
            const [session_id, customer_id, email, family_token, relay_url, plan, created_ms, expires_ms, renewal_of] =
              bound.params;
            if (find(session_id)) return { meta: { changes: 0 } };
            rows.push({
              session_id, customer_id, email, family_token, relay_url, plan, created_ms, expires_ms, renewal_of,
              status: "active", provisioned_ms: null, email_sent_ms: null, expiry_reminded_for_ms: null,
            });
            return { meta: { changes: 1 } };
          }
          // Renewal retiring the prior row's pending reminder for a date the
          // renewal just moved.
          if (sql.includes("SET expiry_reminded_for_ms = expires_ms")) {
            const row = find(bound.params[0]);
            if (!row) return { meta: { changes: 0 } };
            row.expiry_reminded_for_ms = row.expires_ms;
            return { meta: { changes: 1 } };
          }
          // The reminder's claim and its release, which bind their session id
          // in different positions.
          if (sql.includes("expiry_reminded_for_ms IS NOT ?1")) {
            const [expires, sessionId] = bound.params;
            const row = find(sessionId);
            if (!row || row.expires_ms !== expires || row.expiry_reminded_for_ms === expires) {
              return { meta: { changes: 0 } };
            }
            row.expiry_reminded_for_ms = expires;
            return { meta: { changes: 1 } };
          }
          if (sql.includes("expiry_reminded_for_ms IS ?3")) {
            const row = find(bound.params[1]);
            if (row) row.expiry_reminded_for_ms = bound.params[0];
            return { meta: { changes: 1 } };
          }
          const row = find(bound.params[bound.params.length - 1]);
          if (!row) return { meta: { changes: 0 } };
          for (const column of ["provisioned_ms", "email_sent_ms"]) {
            if (sql.includes(`${column} = NULL`)) {
              row[column] = null;
              return { meta: { changes: 1 } };
            }
            if (sql.includes(`${column} = ?1`)) {
              if (row[column]) return { meta: { changes: 0 } };
              row[column] = bound.params[0];
              return { meta: { changes: 1 } };
            }
          }
          throw new Error(`the purchases stub does not understand: ${sql}`);
        },
      };
    },
  };
}

// The reminder is the only place a renewal link is ever handed out, so the link
// it carries has to be one this site would honour — and the email still has to
// go out, with its buy-another-pass copy, before the secret exists.
for (const secret of ["reminder-secret", undefined]) {
  const rows = [
    {
      session_id: "cs_due",
      status: "active",
      email: "buyer@example.test",
      expires_ms: Date.now() + 2 * day,
      provisioned_ms: 1,
      expiry_reminded_for_ms: null,
    },
  ];
  const sends = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sends.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  };
  try {
    const env = {
      DB: purchasesDb(rows),
      RESEND_API_KEY: "test-key",
      EMAIL_FROM: "pass@cruisemesh.app",
      RENEW_LINK_SECRET: secret,
    };
    await runExpiryReminders(env);
    await runExpiryReminders(env); // the same pass, the next day
  } finally {
    globalThis.fetch = realFetch;
  }
  if (sends.length !== 1) {
    throw new Error(`One reminder per pass, whatever the renewal setup; sent ${sends.length}`);
  }
  const [reminder] = sends;
  // The token is payload.signature, so the capture stops at the sentence's
  // full stop rather than swallowing it.
  const linked = new RegExp("https://cruisemesh[.]app/renew[?]t=([A-Za-z0-9_-]+[.][A-Za-z0-9_-]+)").exec(reminder.text);
  if (secret) {
    if (!linked) throw new Error("With a signing secret set, the reminder must carry a renewal link");
    if ((await verifyRenewToken(secret, linked[1])) !== "cs_due") {
      throw new Error("The renewal link in the reminder must verify back to that purchase");
    }
    if (!reminder.html.includes("Renew your pass")) {
      throw new Error("The reminder's button must offer the renewal, not a second pass");
    }
  } else {
    if (linked) throw new Error("With no signing secret, the reminder must not link a renewal it cannot sign");
    if (!reminder.text.includes("https://cruisemesh.app/pass/")) {
      throw new Error("Without a renewal link, the reminder must fall back to the purchase page");
    }
  }
}

// Following a renewal link must never reveal whether a purchase exists. The
// signature stops strangers minting links at all; this is the second line — a
// valid link naming a purchase that is not there answers exactly like a link
// that was never valid.
{
  const secret = "renew-secret";
  const rows = [{ session_id: "cs_known", status: "active", email: "buyer@example.test" }];
  const env = {
    DB: purchasesDb(rows),
    ASSETS: stubAssets,
    RENEW_LINK_SECRET: secret,
    STRIPE_PRICE_ID: "price_test",
    STRIPE_SECRET_KEY: "sk_test",
  };
  const stripeCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    stripeCalls.push({ url: String(url), body: init?.body ?? "" });
    return new Response(JSON.stringify({ id: "cs_new", url: "https://checkout.stripe.test/session" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  let known;
  let unknown;
  let garbage;
  try {
    const call = (t) => worker.fetch(new Request(`https://cruisemesh.app/renew?t=${t}`), env);
    known = await call(await signRenewToken(secret, "cs_known"));
    unknown = await call(await signRenewToken(secret, "cs_never_existed"));
    garbage = await call("not-a-real-token");
  } finally {
    globalThis.fetch = realFetch;
  }
  if (known.status !== 303 || known.headers.get("location") !== "https://checkout.stripe.test/session") {
    throw new Error("A good renewal link must send the buyer straight to checkout");
  }
  if (unknown.status !== garbage.status) {
    throw new Error("An unknown purchase must not be distinguishable by status code");
  }
  const [unknownBody, garbageBody] = [await unknown.text(), await garbage.text()];
  if (unknownBody !== garbageBody) {
    throw new Error("An unknown purchase must not be distinguishable by response body");
  }
  if (!unknownBody.includes("This renewal link no longer works")) {
    throw new Error("A dead renewal link must get the friendly page, not an error");
  }
  if (stripeCalls.length !== 1) {
    throw new Error("Only a renewal link naming a live purchase may open a checkout");
  }
  // The contract fulfillment reads: renewal metadata and the same price id.
  if (!stripeCalls[0].body.includes("metadata%5Brenewal_of%5D=cs_known")) {
    throw new Error("A renewal checkout must carry metadata[renewal_of] naming the prior purchase");
  }
  if (!stripeCalls[0].body.includes("price_test")) {
    throw new Error("A renewal must check out at the same one-time price as a first purchase");
  }
}

// Renewal fulfillment. The token is reused only while the prior pass is still
// active *at webhook time* — it can be refunded while the buyer is on the
// Stripe page — and the new expiry runs from the later of now and the old one.
const renewalToken = "f".repeat(64);
function priorPurchase(status, expiresMs) {
  return [
    {
      session_id: "cs_prior",
      status,
      email: "onfile@example.test",
      family_token: renewalToken,
      relay_url: "https://relay.cruisemesh.app",
      expires_ms: expiresMs,
      provisioned_ms: 1,
      email_sent_ms: 1,
      expiry_reminded_for_ms: null,
    },
  ];
}

async function fulfilRenewal(rows) {
  const provisioned = [];
  const emails = [];
  const env = {
    DB: purchasesDb(rows),
    RELAY_URL: "https://relay.cruisemesh.app",
    RELAY_ADMIN_ORIGIN: "https://relay.cruisemesh.app",
    RELAY_ADMIN_TOKEN: "admin",
    RESEND_API_KEY: "test-key",
    EMAIL_FROM: "pass@cruisemesh.app",
    STRIPE_SECRET_KEY: "sk_test",
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith("https://api.stripe.com/")) {
      return new Response(
        JSON.stringify({
          id: "cs_renewal",
          payment_status: "paid",
          customer: null,
          // Whatever address the buyer types into Stripe Checkout is ignored
          // on the renewal path; only the address on file is ever mailed.
          customer_details: { email: "typed-in-checkout@example.test" },
          metadata: { renewal_of: "cs_prior" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (target.endsWith("/admin/families")) {
      provisioned.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }
    emails.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  };
  try {
    const purchase = await fulfillCheckoutSession(env, "cs_renewal");
    // Stripe retries the webhook, and the success page calls the same code.
    await fulfillCheckoutSession(env, "cs_renewal");
    await fulfillCheckoutSession(env, "cs_renewal");
    return { purchase, provisioned, emails };
  } finally {
    globalThis.fetch = realFetch;
  }
}

for (const scenario of ["early", "lapsed"]) {
  const now = Date.now();
  const priorExpiry = scenario === "early" ? now + 3 * day : now - 10 * day;
  const rows = priorPurchase("active", priorExpiry);
  const { purchase, provisioned, emails } = await fulfilRenewal(rows);

  // An early renewal lands while the old expiry is inside the reminder
  // window; the renewal must retire that pending reminder or the buyer is
  // told their pass "expires in 3 days" about a date they just moved.
  const prior = rows.find((row) => row.session_id === "cs_prior");
  if (prior.expiry_reminded_for_ms !== prior.expires_ms) {
    throw new Error("A renewal must retire the prior row's pending expiry reminder");
  }

  if (purchase.family_token !== renewalToken) {
    throw new Error("A renewal must keep the family's existing token, or every phone needs setting up again");
  }
  if (purchase.renewal_of !== "cs_prior") {
    throw new Error("A renewal row must record which purchase it renews");
  }
  const expected = (scenario === "early" ? priorExpiry : now) + 30 * day;
  if (Math.abs(purchase.expires_ms - expected) > 60_000) {
    throw new Error(`A ${scenario} renewal must extend from the later of now and the old expiry`);
  }
  if (provisioned.length !== 1 || provisioned[0].token !== renewalToken) {
    throw new Error("A renewal must re-provision the same token exactly once");
  }
  if (provisioned[0].expires_ms !== purchase.expires_ms) {
    throw new Error("The relay must be given the renewed expiry");
  }
  if (emails.length !== 1) {
    throw new Error(`Webhook retries must not re-send the renewal confirmation (sent ${emails.length})`);
  }
  if (emails[0].to !== "onfile@example.test") {
    throw new Error("A renewal may only ever email the address already on file");
  }
  // The phones already hold the credential; re-sending it, or drawing it on a
  // page, would put a live credential back in the open for no reason.
  for (const field of [emails[0].text, emails[0].html, emails[0].subject]) {
    if (field.includes(renewalToken.slice(0, 16)) || field.includes("CMRELAY1:")) {
      throw new Error("A renewal confirmation must not carry the family token or a setup card");
    }
  }
}

// A pass refunded or suspended between checkout and webhook must not have its
// token revived. The customer has paid, so they get an ordinary new pass.
{
  const { purchase, provisioned, emails } = await fulfilRenewal(priorPurchase("refunded", Date.now() + 3 * day));
  if (purchase.family_token === renewalToken) {
    throw new Error("A renewal of a pass that is no longer active must not revive its token");
  }
  if (purchase.renewal_of !== null) {
    throw new Error("With no live pass to extend, the purchase is an ordinary new pass, not a renewal");
  }
  if (provisioned.length !== 1 || provisioned[0].token === renewalToken) {
    throw new Error("The relay must be given the new token, never the revoked one");
  }
  if (emails.length !== 1 || !emails[0].text.includes("CMRELAY1:")) {
    throw new Error("A pass issued this way must still deliver its own setup card");
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }));
  return nested.flat();
}

const retiredPersonalDomain = ["davidjacobson", "work"].join(".");

for (const file of await listFiles("dist")) {
  if (file.endsWith(".png")) continue;
  const content = await readFile(file, "utf8");
  if (content.toLowerCase().includes(retiredPersonalDomain)) {
    throw new Error(`${file} must not reference the retired personal domain`);
  }
  if (file.endsWith(".html") && !content.includes('rel="icon"')) {
    throw new Error(`${file} must link the site favicon`);
  }
}

// Every page meant to be found must be in the sitemap, and nothing else may
// be: the card pages and the purchase success page are noindex and Disallowed,
// and a crawler holding one of those URLs is the failure this guards against.
const sitemap = await readFile("dist/sitemap.xml", "utf8");
for (const file of await listFiles("dist")) {
  const path = file.replaceAll("\\", "/");
  if (!path.endsWith(".html") || path.endsWith("/404.html")) continue;
  const content = await readFile(file, "utf8");
  const location = `https://cruisemesh.app${path.replace(/^dist/, "").replace(/index\.html$/, "")}`;
  const indexable = !content.includes('content="noindex');
  if (indexable && !sitemap.includes(`<loc>${location}</loc>`)) {
    throw new Error(`${file} is indexable but missing from dist/sitemap.xml (${location})`);
  }
  if (!indexable && sitemap.includes(`<loc>${location}</loc>`)) {
    throw new Error(`${file} is noindex but listed in dist/sitemap.xml (${location})`);
  }
}

// Link previews 404 without the baked images; regenerate with `npm run bake-images`.
for (const image of ["dist/og.png", "dist/apple-touch-icon.png", "dist/icon.svg"]) {
  await readFile(image);
}

// Binary assets must survive the trip through git. With no .gitattributes and
// core.autocrlf=true, committing the explainer video from a Windows checkout
// stripped every CR that preceded an LF inside the compressed stream — 135 of
// them — and shipped a file no player would open. A binary diff reads only
// "Bin 7656856 -> 7656721 bytes", so nothing flagged it; the .gitattributes
// added alongside this check is the actual fix, and this is the tripwire that
// tells us if it ever stops working.
//
// Walking the top-level MP4 box structure catches the general failure: any
// truncation or dropped byte desynchronises the length prefixes, so the walk
// lands somewhere other than exactly the end of the file.
const video = await readFile("dist/cruisemesh-explainer.mp4");
if (video.readUInt32BE(4) !== 0x66747970) {
  throw new Error("Explainer video does not begin with an MP4 ftyp box — the file is corrupt");
}
const boxes = [];
for (let offset = 0; offset < video.length; ) {
  const size = video.readUInt32BE(offset);
  boxes.push(video.toString("latin1", offset + 4, offset + 8));
  if (size < 8) {
    throw new Error(`Explainer video has a ${size}-byte MP4 box at offset ${offset} — the file is corrupt`);
  }
  offset += size;
  if (offset > video.length) {
    throw new Error("Explainer video's MP4 boxes overrun the end of the file — it is truncated or corrupt");
  }
}
// Without moov a player has no index and iOS Safari shows a black frame.
if (!boxes.includes("moov")) {
  throw new Error(`Explainer video is missing its moov atom (found: ${boxes.join(", ")})`);
}
// CR-stripping only ever shrinks a file, and it hits PNGs too.
for (const [image, expected] of [["dist/og.png", 0x89504e47], ["dist/apple-touch-icon.png", 0x89504e47]]) {
  const bytes = await readFile(image);
  if (bytes.readUInt32BE(0) !== expected) {
    throw new Error(`${image} does not begin with a PNG signature — the file is corrupt`);
  }
  // A PNG closes with length(4) + "IEND" + CRC(4), so the marker is the four
  // bytes before the final four, not the last four.
  if (bytes.toString("latin1", bytes.length - 8, bytes.length - 4) !== "IEND") {
    throw new Error(`${image} does not end with an IEND chunk — it is truncated or corrupt`);
  }
}

const redirect = redirectWorker.fetch(new Request("https://cruisemesh.com/f?source=short-domain"));
if (redirect.status !== 308) {
  throw new Error("Short domain must use a permanent 308 redirect");
}
if (redirect.headers.get("Location") !== "https://cruisemesh.app/f?source=short-domain") {
  throw new Error("Short domain must preserve the request path and query string");
}
// A hostname absent from here has no DNS record at all — `custom_domain: true`
// is what creates it. Both www forms were missing, so anyone who typed one got
// a browser error rather than the site.
const redirectConfig = await readFile("wrangler.redirect.jsonc", "utf8");
for (const hostname of ["cruisemesh.com", "www.cruisemesh.com", "www.cruisemesh.app"]) {
  if (!redirectConfig.includes(`"${hostname}"`)) {
    throw new Error(`${hostname} must be a custom domain on the redirect Worker, or it does not resolve`);
  }
}

console.log("Static site checks passed.");
