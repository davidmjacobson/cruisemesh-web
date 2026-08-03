-- Renewal: extending an existing pass instead of selling a second one.
--
-- The point of a renewal is that the family token does not change, so no
-- phone is set up twice. That makes a renewal a new purchases row carrying
-- the *same* family_token as the row it renews, linked by renewed_from, with
-- the prior row moved to status 'renewed' so the expiry-reminder cron and the
-- reconciliation job both stop treating it as the live pass for that family.
--
-- Ownership without accounts is a one-time code emailed to the address on the
-- purchase (src/renew.js): the expiry reminder carries one, and /pass/renew/
-- re-sends one on request. The code identifies which pass to extend; it is
-- never the family token and never grants access to messages.
--
-- Apply with: npx wrangler d1 migrations apply cruisemesh-web --remote
ALTER TABLE purchases ADD COLUMN renewed_from TEXT;

CREATE TABLE renewals (
  code                TEXT PRIMARY KEY,  -- random, appears in the emailed link
  session_id          TEXT NOT NULL,     -- the purchase this code renews
  created_ms          INTEGER NOT NULL,
  expires_ms          INTEGER NOT NULL,  -- link validity, not pass validity
  sent_ms             INTEGER,           -- last time a link email went out (rate limit)
  redeemed_ms         INTEGER,           -- first paid renewal started from this code
  redeemed_session_id TEXT               -- the checkout session that redeemed it
);
CREATE INDEX renewals_session ON renewals (session_id);
