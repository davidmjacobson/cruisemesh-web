-- System of record linking Stripe checkout sessions to relay family tokens.
-- Apply with: npx wrangler d1 migrations apply cruisemesh-web --remote
CREATE TABLE purchases (
  session_id     TEXT PRIMARY KEY,  -- Stripe checkout session id (idempotency key)
  customer_id    TEXT,              -- Stripe customer id, if any
  email          TEXT NOT NULL,     -- checkout email; credential delivery + support lookup
  family_token   TEXT NOT NULL,     -- the relay bearer token minted for this purchase
  relay_url      TEXT NOT NULL,     -- which relay host the token was provisioned on
  plan           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  created_ms     INTEGER NOT NULL,
  expires_ms     INTEGER,
  provisioned_ms INTEGER,           -- set once the relay admin API accepted the token
  email_sent_ms  INTEGER            -- set once the credential email was sent
);
CREATE INDEX purchases_email ON purchases (email);
