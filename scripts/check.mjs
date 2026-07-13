import { readFile } from "node:fs/promises";

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

console.log("Static site checks passed.");

