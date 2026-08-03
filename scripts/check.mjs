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
for (const requiredText of ["Settings → Cruise Pass", "Connection details", "Test and use"]) {
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
  throw new Error("Credential email must not imply that friend cards configure Cruise Pass");
}

// The expiring-pass reminder. Renewal now exists, so the reminder points at
// it — but nothing auto-renews, and saying otherwise would turn a one-time
// payment into an implied subscription. It also has to keep saying what still
// works without a pass, or the email reads as "CruiseMesh stops working".
if (!emailSource.includes("https://cruisemesh.app/pass/")) {
  throw new Error("Expiry reminder must link the real purchase page");
}
if (!emailSource.includes("https://cruisemesh.app/pass/renew/")) {
  throw new Error("Expiry reminder must link the renewal page");
}
for (const banned of ["renews automatically", "auto-renew", "will be charged", "subscription renews"]) {
  if (emailSource.toLowerCase().includes(banned.toLowerCase())) {
    throw new Error(`Pass email must not imply an automatic renewal ("${banned}")`);
  }
}
for (const requiredText of ["Nothing renews on its own", "Bluetooth and local Wi-Fi", "nothing to set up again"]) {
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

// Renewal. The entire promise is that extending a pass keeps the family token,
// so no phone is set up twice — a renewal that minted a fresh token would be
// an ordinary second purchase wearing the word "renew", and every family would
// find that out mid-trip.
const renewSource = await readFile("src/renew.js", "utf8");
const fulfillSource = await readFile("src/fulfill.js", "utf8");
if (!fulfillSource.includes("renewing ? renewing.family_token : generateFamilyToken()")) {
  throw new Error("A renewal must reuse the family token of the pass it renews, or every phone needs setting up again");
}
// The superseded row staying 'active' is what would mail "your pass expires in
// 3 days" about a date the customer has already paid past.
if (!fulfillSource.includes("SET status = 'renewed'")) {
  throw new Error("Fulfilling a renewal must retire the row it supersedes, or the expiry reminder fires on the old date");
}
// D1 has no transactions, so reading the live expiry, adding thirty days and
// inserting is three independent statements: two renewals of one family
// landing together would both read E and both write E+30 — two charges, one
// extension, and two 'active' rows mailing duplicate reminders. The insert
// therefore refuses when the family has already moved past the date the
// extension was computed from, and the loser retries onto the new date.
if (!/NOT EXISTS\s*\(\s*SELECT 1 FROM purchases/.test(fulfillSource)) {
  throw new Error("The renewal insert must be guarded against a concurrent renewal of the same family");
}
// The value the guard compares against is what the live row said a moment ago
// — NOT the date the new term is measured from. Binding the billing base as
// the witness compared a refunded family against 0, so the insert refused
// every attempt: charged, never fulfilled, and invisible to reconciliation
// because no row was ever written. The two dates differ only for refunded
// passes, which is why nothing but running the real statement catches it.
if (!/const witness = renewing \? renewing\.expires_ms \?\? 0 : 0;/.test(fulfillSource)) {
  throw new Error("The renewal guard must compare against the live row's own expiry, not the billing base");
}
// ...and that it is the value actually bound. The SQL exercise below supplies
// its own bindings, so without this the wiring could still pass `base` while
// every executed assertion stayed green.
if (!/renewing \? renewing\.session_id : null,\s*witness,/.test(fulfillSource)) {
  throw new Error("The renewal insert must bind `witness` as its guard parameter");
}
// Executed further down, once PLAN and the renew.js helpers it binds are in
// scope — see checkRenewalInsertSql.
// ...and the bookkeeping must not live inside the branch that inserted, or a
// runner dying in between leaves the superseded row 'active' with no retry.
if (!/if \(purchase\.renewed_from\) \{/.test(fulfillSource)) {
  throw new Error("Renewal bookkeeping must run on every fulfillment call, not only the one that inserted the row");
}
// The renewal form is the way back in for someone who no longer has the email,
// and `=` in SQLite is case-sensitive: a buyer who typed John@Example.com at
// checkout would be told a link was sent, forever, and never receive one.
if (!fulfillSource.includes(".toLowerCase()")) {
  throw new Error("Checkout emails must be stored lowercased, or mixed-case buyers cannot renew");
}
if (!renewSource.includes("lower(email) = lower(?1)")) {
  throw new Error("Renewal lookup must match addresses case-insensitively for rows stored before that");
}
// Refunded days were given back as money; handing them back again as time
// would make $9.99 buy a refund plus a free month.
const { extensionBase: baseFor } = await import("../src/renew.js");
if (baseFor({ status: "refunded", expires_ms: 999 }) !== null) {
  throw new Error("A refunded pass must extend from today, not from the date its refund paid for");
}
if (baseFor({ status: "active", expires_ms: 999 }) !== 999) {
  throw new Error("An active pass must extend from its paid-through date");
}
// A paid renewal that cannot be matched to a pass gives the customer the one
// thing the checkout page promised it would not: a new token to set up
// everywhere. It has to page someone, not just log.
if (!fulfillSource.includes("alertOrphanedRenewal")) {
  throw new Error("A renewal fulfilled as a new pass must alert the operator");
}
if (!workerSource.includes("renew_session") && !(await readFile("src/stripe.js", "utf8")).includes("renew_session")) {
  throw new Error("Renewal checkouts must carry a fallback identifier for a code that expires before payment");
}
if (!(await readFile("migrations/0004_renewal.sql", "utf8")).includes("renewed_from")) {
  throw new Error("migrations must add the renewed_from column src/fulfill.js writes");
}
const { extendedExpiry: extend, maskEmail: mask } = await import("../src/renew.js");
const { PLAN: plan } = await import("../src/relay.js");
const term = plan.days * day;
// Renewing early must add to the paid-through date, never restart from today:
// a buyer who renews the day the reminder lands would otherwise donate the
// remaining days back.
if (extend(10 * day, 5 * day) !== 10 * day + term) {
  throw new Error("Renewing early must extend from the current expiry, not from today");
}
// ...and a lapsed pass has no remaining days to add to.
if (extend(5 * day, 10 * day) !== 10 * day + term) {
  throw new Error("Renewing a lapsed pass must run from today, not from a date in the past");
}
// With those in scope, run the real INSERT against the real migrations.
await checkRenewalInsertSql(fulfillSource);
if (extend(null, 10 * day) !== 10 * day + term) {
  throw new Error("Renewing a pass with no expiry must still produce one");
}
// Every date a customer is shown before paying has to be the date fulfillment
// will actually deliver. Both derive from extensionBase, because they differ
// for a refunded pass — quoting the old paid-through date on the button would
// take money against up to thirty days that will not be given.
// Only the two places that quote a date *before* the money moves: everywhere
// else, a fulfilled row's expires_ms is the truth and quoting it is right.
const functionBody = (source, marker) => {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Could not find ${marker} to check its quoted dates`);
  const rest = source.slice(start + marker.length);
  const end = rest.search(/\n(?:export )?(?:async )?function /);
  return rest.slice(0, end < 0 ? undefined : end);
};
for (const [label, body] of [
  ["The renewal page", functionBody(workerSource, "async function handleRenewPage")],
  ["The renewal link email", functionBody(emailSource, "export async function sendRenewalLinkEmail")],
]) {
  if (/purchase\.expires_ms/.test(body)) {
    throw new Error(`${label} must quote dates via extensionBase, not raw expires_ms — they differ for a refunded pass`);
  }
  if (!body.includes("extensionBase(purchase)")) {
    throw new Error(`${label} must derive its dates the way fulfillment does`);
  }
}

// The renewal page is reachable by anyone holding the link, so it names the
// address in masked form only.
if (mask("someone@example.com").includes("someone")) {
  throw new Error("The renewal page must not print the buyer's full address");
}
if (!mask("someone@example.com").endsWith("@example.com")) {
  throw new Error("A masked address must keep its domain, or nobody can tell which pass it is");
}
// Enumeration: the renewal request endpoint answers identically whether or not
// an address bought a pass, so it can never be used to ask "is this person a
// CruiseMesh customer?".
if (!workerSource.includes("sameForEveryone")) {
  throw new Error("The renewal request endpoint must answer identically for known and unknown addresses");
}
if (!renewSource.includes("RENEW_EMAIL_COOLDOWN_MS")) {
  throw new Error("Renewal link emails must be rate limited, or the form is an inbox flooder");
}
// Identical words are not an identical answer: a known address that spends a
// Resend round-trip before replying times the difference out loud, which is
// the same enumeration the wording is there to prevent.
if (!workerSource.includes("ctx.waitUntil(deliver())")) {
  throw new Error("The renewal request must answer before looking the address up, or its timing enumerates customers");
}
// A reminder claimed for a row that a renewal has just retired mails "expires
// in 3 days" minutes after the customer paid to extend it.
if (!/UPDATE purchases SET expiry_reminded_for_ms[\s\S]{0,200}status = 'active'/.test(opsSource)) {
  throw new Error("The expiry-reminder claim must require status='active', or a just-renewed pass still gets reminded");
}
// A renewal link is a payment page for one family's pass; it must not be
// crawlable, in the page's own head and in robots.txt.
const renewPage = await readFile("dist/pass/renew/index.html", "utf8");
if (!renewPage.includes('content="noindex')) {
  throw new Error("dist/pass/renew/index.html must be noindex; renewal codes arrive on that path");
}
if (!robots.includes("Disallow: /pass/renew/")) {
  throw new Error("robots.txt must disallow /pass/renew/, where renewal codes land");
}

// The renewal insert, executed rather than pattern-matched.
//
// Everything else in this file checks the *shape* of the source, which is
// enough for copy and for wiring, and is not enough here: the guard's failure
// mode is a statement that parses, reads sensibly, and refuses to insert for
// one class of customer. That is how a fix for the refund accounting silently
// stranded every refunded renewal — charged, no row written, nothing for the
// reconciliation job to find. So the real statement is lifted out of
// src/fulfill.js, run against the real migrations in an in-memory SQLite, and
// asked the questions that matter.
async function checkRenewalInsertSql(source) {
  // node:sqlite is experimental and says so on stderr; that warning is not a
  // finding and must not be the loudest thing `npm run check` prints.
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (String(warning).includes("SQLite is an experimental feature")) return;
    return emitWarning.call(process, warning, ...rest);
  };
  const { DatabaseSync } = await import("node:sqlite");
  process.emitWarning = emitWarning;

  const statement = /INSERT INTO purchases \(session_id, customer_id[\s\S]*?DO NOTHING/.exec(source)?.[0];
  if (!statement) throw new Error("Could not find the renewal INSERT in src/fulfill.js to exercise");

  const db = new DatabaseSync(":memory:");
  for (const file of (await readdir("migrations")).sort()) {
    db.exec(await readFile(join("migrations", file), "utf8"));
  }
  const insert = db.prepare(statement);
  const now = 2_000_000_000_000;
  const term = plan.days * day;
  // Mirrors insertPurchaseRow: witness is the live row's own expiry, base is
  // what the term is measured from.
  const renew = (sessionId, live) =>
    insert.run(
      sessionId, null, "buyer@example.com", live.family_token, "https://relay.example",
      plan.id, now, extend(baseFor(live), now), live.session_id, live.expires_ms ?? 0,
    ).changes;
  const seed = (row) =>
    db.prepare(
      `INSERT INTO purchases (session_id, email, family_token, relay_url, plan, status, created_ms, expires_ms)
       VALUES (?, 'buyer@example.com', ?, 'https://relay.example', ?, ?, ?, ?)`,
    ).run(row.session_id, row.family_token, plan.id, row.status, row.created_ms ?? 1, row.expires_ms);
  const liveRow = (token) =>
    db.prepare(
      "SELECT * FROM purchases WHERE family_token = ? ORDER BY COALESCE(expires_ms, 0) DESC, created_ms DESC LIMIT 1",
    ).get(token);

  // A refunded pass must still be renewable: its own expiry is the witness,
  // while the term runs from today because the refunded days were paid back.
  seed({ session_id: "cs_refunded", family_token: "FAM_R", status: "refunded", expires_ms: now + 5 * day });
  if (renew("cs_r2", liveRow("FAM_R")) !== 1) {
    throw new Error("Renewing a refunded pass must insert; the customer has paid and nothing else will write this row");
  }
  if (liveRow("FAM_R").expires_ms !== now + term) {
    throw new Error("A refunded pass must extend from today, not from the date its refund paid back");
  }

  // Two renewals of one family racing: the second carries a witness that has
  // gone stale, and must lose rather than overwrite the first's extension.
  seed({ session_id: "cs_a", family_token: "FAM_C", status: "active", expires_ms: now + 10 * day });
  const stale = liveRow("FAM_C");
  if (renew("cs_b", stale) !== 1) throw new Error("The first of two concurrent renewals must win");
  if (renew("cs_c", stale) !== 0) {
    throw new Error("A renewal carrying a stale expiry must lose the guard, or one of two payments buys nothing");
  }
  // ...and on the retry it stacks onto the extended date: two payments, sixty days.
  if (renew("cs_c", liveRow("FAM_C")) !== 1) throw new Error("A retried renewal must stack onto the new date");
  if (liveRow("FAM_C").expires_ms !== now + 10 * day + 2 * term) {
    throw new Error("Two paid renewals must add two terms, not one");
  }

  // A pass with no expiry at all, and a brand-new purchase, must never be
  // blocked: the guard only governs renewals.
  seed({ session_id: "cs_null", family_token: "FAM_N", status: "active", expires_ms: null });
  if (renew("cs_n2", liveRow("FAM_N")) !== 1) throw new Error("Renewing a pass with no expiry must insert");
  if (insert.run("cs_fresh", null, "new@example.com", "FAM_NEW", "https://relay.example",
    plan.id, now, now + term, null, 0).changes !== 1) {
    throw new Error("A new purchase must never be blocked by the renewal guard");
  }

  // The live-row query, run rather than read. Its ORDER BY decides which row
  // every later resolve, quoted date and guard comparison keys off, and a
  // refunded renewal can carry a later expiry than the pass that replaced it.
  const liveSql = /SELECT \* FROM purchases\s*\n\s*WHERE family_token = \?1[\s\S]*?LIMIT 1/.exec(
    await readFile("src/renew.js", "utf8"),
  )?.[0];
  if (!liveSql) throw new Error("Could not find livePurchaseForFamily's query in src/renew.js to exercise");
  seed({ session_id: "cs_paid", family_token: "FAM_X", status: "active", created_ms: 2, expires_ms: now + 40 * day });
  seed({ session_id: "cs_refunded_late", family_token: "FAM_X", status: "refunded", created_ms: 1, expires_ms: now + 60 * day });
  if (db.prepare(liveSql).get("FAM_X").session_id !== "cs_paid") {
    throw new Error("A refunded row must never outrank a paid one as the live pass, whatever its expiry");
  }

  // The redeem UPDATE, likewise. It re-runs on every fulfillment call, so it
  // must not reach forward and spend a code minted after the renewal it
  // records — which would stamp a redemption earlier than the code's own
  // creation and void the cooldown that code was still under.
  const redeemSql = /UPDATE renewals SET redeemed_ms[\s\S]*?family_token = \?3\)/.exec(fulfillSource)?.[0];
  if (!redeemSql) throw new Error("Could not find the redeem UPDATE in src/fulfill.js to exercise");
  const code = (name, sessionId, createdMs) =>
    db.prepare("INSERT INTO renewals (code, session_id, created_ms, expires_ms) VALUES (?, ?, ?, ?)")
      .run(name, sessionId, createdMs, now + 90 * day);
  code("before", "cs_a", now - day);   // outstanding when the renewal was paid
  code("after", "cs_b", now + day);    // minted later, by the expiry cron
  db.prepare(redeemSql).run(now, "cs_b", "FAM_C");
  const redeemed = (name) => db.prepare("SELECT redeemed_ms FROM renewals WHERE code = ?").get(name).redeemed_ms;
  if (redeemed("before") === null) throw new Error("A renewal must spend the codes outstanding when it was paid for");
  if (redeemed("after") !== null) {
    throw new Error("A renewal must not spend a code minted after it; that back-dates a redemption and voids the cooldown");
  }
  db.close();
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
