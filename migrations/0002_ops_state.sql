-- Tiny key/value state for the scheduled ops crons (src/ops.js): today just
-- the /healthz outage flag that keeps uptime alerting at one email per outage
-- plus one recovery, never a 15-minute alert storm.
-- Apply with: npx wrangler d1 migrations apply cruisemesh-web --remote
CREATE TABLE ops_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,     -- JSON blob owned by the cron that writes it
  updated_ms INTEGER NOT NULL
);
