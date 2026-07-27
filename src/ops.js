// Paid-tier ops crons (CP2c): relay /healthz uptime alerting and the weekly
// Stripe-D1 <-> relay-families reconciliation. Entry points are dispatched
// from the `scheduled` handler in index.js on the expressions below, which
// must byte-match wrangler.jsonc `triggers.crons` (check.mjs enforces it —
// a drifted string would silently run the wrong job, because every
// unmatched cron falls through to the uptime probe).

export const UPTIME_CRON = "*/15 * * * *";
export const RECONCILE_CRON = "23 14 * * 1"; // Mondays 14:23 UTC

// Ops mail goes to the operator, not a buyer, so the addresses are fixed
// here rather than riding EMAIL_FROM (that var is the buyer-facing pass@
// sender used by credential emails).
const OPS_EMAIL_TO = "davejake@gmail.com";
const OPS_EMAIL_FROM = "CruiseMesh Ops <ops@cruisemesh.app>";

const HEALTHZ_TIMEOUT_MS = 10_000;
// A blown probe is confirmed once before it counts as an outage: 15-minute
// probes over the public internet do hiccup, and the cost of confirming
// (30 s longer time-to-alert) is nothing next to a 3 a.m. false page.
const HEALTHZ_CONFIRM_DELAY_MS = 30_000;

const ADMIN_TIMEOUT_MS = 15_000;
// Flag a relay expiry that undercuts what the customer paid for, with an
// hour of slack so clock jitter between D1 and the relay never pages.
const EXPIRY_SLACK_MS = 60 * 60 * 1000;

// Same masking as tools/relay_admin.sh in the main repo: the first 12
// characters are a usable lookup prefix and never the credential itself.
// Full family tokens must not ride in email.
function tokenPrefix(token) {
  return `${String(token).slice(0, 12)}…`;
}

async function sendOpsEmail(env, subject, text) {
  if (!env.RESEND_API_KEY) {
    // Fresh deploy / local dev: never let a missing secret turn an alert
    // into a silent no-op — the text still lands in the logs.
    console.error(`RESEND_API_KEY unset; ops email not sent: ${subject}\n${text}`);
    return;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: OPS_EMAIL_FROM,
      to: OPS_EMAIL_TO,
      reply_to: "support@cruisemesh.app",
      subject,
      text,
    }),
  });
  if (!response.ok) {
    throw new Error(`Resend rejected the ops email (HTTP ${response.status}): ${await response.text()}`);
  }
}

function readOpsState(env, key) {
  return env.DB.prepare("SELECT value FROM ops_state WHERE key = ?1")
    .bind(key)
    .first()
    .then((row) => (row ? JSON.parse(row.value) : null));
}

function writeOpsState(env, key, value) {
  return env.DB.prepare(
    `INSERT INTO ops_state (key, value, updated_ms) VALUES (?1, ?2, ?3)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_ms = excluded.updated_ms`,
  )
    .bind(key, JSON.stringify(value), Date.now())
    .run();
}

async function probeHealthz(env) {
  try {
    const response = await fetch(`${env.RELAY_URL}/healthz`, {
      signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: String(error) };
  }
}

export async function runUptimeCheck(env) {
  let probe = await probeHealthz(env);
  if (!probe.ok) {
    await new Promise((resolve) => setTimeout(resolve, HEALTHZ_CONFIRM_DELAY_MS));
    probe = await probeHealthz(env);
  }
  const now = Date.now();
  const state = (await readOpsState(env, "healthz")) ?? { status: "up", changed_ms: null };

  if (probe.ok) {
    if (state.status === "down") {
      // Email before recording the transition: if the send fails, the next
      // probe retries the mail instead of losing it. The reverse order can
      // go silent forever; a rare duplicate is the better failure.
      const minutes = state.changed_ms ? Math.round((now - state.changed_ms) / 60_000) : null;
      await sendOpsEmail(
        env,
        "Relay recovered: /healthz responding again",
        [
          `${env.RELAY_URL}/healthz is answering again as of ${new Date(now).toISOString()}.`,
          minutes === null ? "" : `The outage lasted about ${minutes} minutes (detection is 15-minute-coarse).`,
          "",
          "No action needed; this is the one-time recovery notice.",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      await writeOpsState(env, "healthz", { status: "up", changed_ms: now });
    }
    return;
  }

  if (state.status !== "down") {
    await sendOpsEmail(
      env,
      "ALERT: relay /healthz is failing",
      [
        `${env.RELAY_URL}/healthz failed two probes ${HEALTHZ_CONFIRM_DELAY_MS / 1000} s apart (${probe.detail}) at ${new Date(now).toISOString()}.`,
        "",
        "This is the only alert for this outage; a recovery email follows when /healthz answers again.",
        "Box: ssh root@relay.cruisemesh.app, then docker compose -f /opt/cruisemesh/relayd/docker-compose.yml ps / logs.",
      ].join("\n"),
    );
    await writeOpsState(env, "healthz", { status: "down", changed_ms: now });
  } else {
    console.log(
      `healthz still down since ${new Date(state.changed_ms).toISOString()} (${probe.detail}); already alerted`,
    );
  }
}

async function listRelayFamilies(env) {
  const families = [];
  const limit = 500; // the server-side clamp (relayd DEPLOY.md §12)
  for (let offset = 0; ; offset += limit) {
    const response = await fetch(
      `${env.RELAY_ADMIN_ORIGIN}/admin/families?limit=${limit}&offset=${offset}`,
      {
        headers: { authorization: `Bearer ${env.RELAY_ADMIN_TOKEN}` },
        signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
      },
    );
    if (!response.ok) throw new Error(`relay admin family list failed (HTTP ${response.status})`);
    const page = await response.json();
    families.push(...page.families);
    if (page.families.length === 0 || families.length >= page.total) return families;
  }
}

async function buildReconciliationReport(env) {
  const now = Date.now();
  const { results: purchases } = await env.DB.prepare(
    "SELECT session_id, email, family_token, status, expires_ms, provisioned_ms FROM purchases",
  ).all();
  const families = await listRelayFamilies(env);
  const familyByToken = new Map(families.map((family) => [family.token, family]));
  const purchasedTokens = new Set(purchases.map((purchase) => purchase.family_token));

  const urgent = [];
  for (const purchase of purchases) {
    if (purchase.status !== "active") continue;
    // A lapsed pass is allowed to be expired/absent on the relay; the relay's
    // own expiry + grace handling owns that lifecycle.
    if (purchase.expires_ms && purchase.expires_ms <= now) continue;
    const label = `${purchase.session_id} (${purchase.email || "no email"}, token ${tokenPrefix(purchase.family_token)})`;
    const family = familyByToken.get(purchase.family_token);
    if (!purchase.provisioned_ms) {
      urgent.push(`${label}: paid but never provisioned — the stranded-customer case. Look the session up in D1 and provision its token.`);
    } else if (!family) {
      urgent.push(`${label}: provisioned once, but the token is now missing on the relay (families table wiped or purged?). Re-provision from the D1 row.`);
    } else if (family.status !== "active") {
      urgent.push(`${label}: relay family is ${family.status} while the purchase is active.`);
    } else if (
      family.expires_ms !== null &&
      (purchase.expires_ms ?? Number.POSITIVE_INFINITY) > family.expires_ms + EXPIRY_SLACK_MS
    ) {
      const paidThrough = purchase.expires_ms ? new Date(purchase.expires_ms).toISOString() : "never";
      urgent.push(
        `${label}: relay expiry ${new Date(family.expires_ms).toISOString()} undercuts the paid-through date ${paidThrough}.`,
      );
    }
  }

  // The other direction. Families with no purchase row are expected —
  // dev/test provisions via relay_admin.sh — so they never trigger an email
  // by themselves; they ride along as context when one is sent anyway.
  const unmatched = families.filter((family) => !purchasedTokens.has(family.token));

  if (urgent.length === 0) {
    console.log(
      `reconciliation clean: ${purchases.length} purchase rows vs ${families.length} relay families (${unmatched.length} dev/test); staying silent`,
    );
    return null;
  }

  const lines = [
    "Weekly Cruise Pass reconciliation (D1 purchases vs relay families).",
    "",
    "URGENT — paying customers affected:",
    ...urgent.map((line) => `- ${line}`),
  ];
  if (unmatched.length > 0) {
    lines.push(
      "",
      "For context, relay families with no purchase row (expected for dev/test):",
      ...unmatched.map(
        (family) =>
          `- ${tokenPrefix(family.token)} status=${family.status} plan=${family.plan ?? "-"} note=${family.note ?? "-"}`,
      ),
    );
  }
  lines.push("", `Checked ${purchases.length} purchase rows against ${families.length} relay families.`);
  return lines.join("\n");
}

export async function runReconciliation(env) {
  try {
    const report = await buildReconciliationReport(env);
    if (report) {
      await sendOpsEmail(env, "ALERT: Cruise Pass reconciliation found mismatches", report);
    }
  } catch (error) {
    // The weekly cadence is its own storm control here: a reconciliation
    // that cannot run (bad admin token, relay down all run long) must not
    // stay quietly green, because silence is the healthy signal.
    console.error(`reconciliation failed: ${error}`);
    await sendOpsEmail(
      env,
      "ALERT: Cruise Pass reconciliation could not run",
      `The weekly purchases <-> relay families reconciliation failed:\n\n${error}\n\nUntil this runs green, stranded (paid-but-not-provisioned) passes go undetected.`,
    );
  }
}
