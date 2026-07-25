import { readdir, readFile } from "node:fs/promises";
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

const relayPage = await readFile("dist/r/index.html", "utf8");
if (!relayPage.includes("location.hash")) {
  throw new Error("Relay setup page must read the card from the URL fragment");
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
for (const requiredText of ["CruiseMesh 1.0.2", "Save and check later", "Show setup QR"]) {
  if (!supportPage.includes(requiredText) && !(await readFile("src/email.js", "utf8")).includes(requiredText)) {
    throw new Error(`Public setup instructions must include ${requiredText}`);
  }
}

const workerSource = await readFile("src/index.js", "utf8");
for (const requiredText of ["Open in CruiseMesh", "Test and save", "Copy setup card", "Set up another phone", "Custom relay details"]) {
  if (!workerSource.includes(requiredText)) throw new Error(`Purchase success flow must include ${requiredText}`);
}
if (!workerSource.includes("renderSVG") || !workerSource.includes("setup-qr")) {
  throw new Error("Purchase success flow must render an in-page second-phone setup QR");
}
const emailSource = await readFile("src/email.js", "utf8");
if (!emailSource.includes("each family phone needs this setup")) {
  throw new Error("Credential email must explain that every family phone needs setup");
}
if (emailSource.includes("shared automatically through the friend cards")) {
  throw new Error("Credential email must not imply that friend cards configure Cruise Pass");
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
  const content = await readFile(file, "utf8");
  if (content.toLowerCase().includes(retiredPersonalDomain)) {
    throw new Error(`${file} must not reference the retired personal domain`);
  }
}

const redirect = redirectWorker.fetch(new Request("https://cruisemesh.com/f?source=short-domain"));
if (redirect.status !== 308) {
  throw new Error("Short domain must use a permanent 308 redirect");
}
if (redirect.headers.get("Location") !== "https://cruisemesh.app/f?source=short-domain") {
  throw new Error("Short domain must preserve the request path and query string");
}

console.log("Static site checks passed.");
