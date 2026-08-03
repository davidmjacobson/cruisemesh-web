-- Idempotency for the daily "your pass expires soon" reminder (src/ops.js).
-- The reminder window is three days wide and the cron runs daily, so the same
-- purchase matches up to three times — plus whatever a cron retry adds. The
-- column stores *which* expiry was reminded about, not just that a reminder
-- went out, so a pass whose expires_ms is later extended still gets a fresh
-- reminder for the new date and never a second one for the old.
-- Apply with: npx wrangler d1 migrations apply cruisemesh-web --remote
ALTER TABLE purchases ADD COLUMN expiry_reminded_for_ms INTEGER;
