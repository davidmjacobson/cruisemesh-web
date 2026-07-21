// Client for the relayd admin API (Phase 1 of monetize-plan.md, lives in
// ../cruisemesh/relayd). Until that ships, provisioning fails and purchases
// stay in the "activation pending" state; webhook retries pick them up.

export const PLAN = { id: "cruise-pass-30d", days: 30 };

export function generateFamilyToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function provisionFamily(env, familyToken, expiresMs) {
  const response = await fetch(`${env.RELAY_ADMIN_ORIGIN}/admin/families`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RELAY_ADMIN_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ token: familyToken, plan: PLAN.id, expires_ms: expiresMs }),
  });
  if (!response.ok) {
    throw new Error(`relay admin provisioning failed (${response.status})`);
  }
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

// One-tap setup token. Format (to be mirrored by the apps): `CMRELAY1:` +
// base64url-nopad of UTF-8 JSON {"v":1,"relay_url":...,"relay_token":...}.
// Carried in a URL fragment (https://cruisemesh.app/r#CMRELAY1:...) so the
// token never reaches server logs, same as CMFRIEND links.
export function relaySetupToken(relayUrl, relayToken) {
  const payload = JSON.stringify({ v: 1, relay_url: relayUrl, relay_token: relayToken });
  return `CMRELAY1:${base64UrlEncode(new TextEncoder().encode(payload))}`;
}

export function relaySetupLink(origin, relayUrl, relayToken) {
  return `${origin}/r#${relaySetupToken(relayUrl, relayToken)}`;
}
