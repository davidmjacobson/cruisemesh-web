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

// The expiring-pass reminder. Passes do not renew and there is no renewal
// endpoint, so the reminder may never imply one: a buyer told their pass
// renews would sail with nothing. It also has to say what still works
// without a pass, or the email reads as "CruiseMesh stops working".
if (!emailSource.includes("https://cruisemesh.app/pass/")) {
  throw new Error("Expiry reminder must link the real purchase page");
}
for (const banned of ["renew your pass", "renews automatically", "auto-renew", "Renew now"]) {
  if (emailSource.toLowerCase().includes(banned.toLowerCase())) {
    throw new Error(`Expiry reminder must not promise a renewal flow that does not exist ("${banned}")`);
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
