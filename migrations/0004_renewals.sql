-- Renewals (src/renew.js, src/fulfill.js). A renewal is an ordinary purchase
-- row for the new Stripe session that carries the SAME family_token as the
-- purchase it renews, so nothing on the family's phones has to change. The
-- link back to the prior session is what tells fulfillment, support, and the
-- weekly reconciliation that a shared token is intentional rather than a
-- collision.
-- Apply with: npx wrangler d1 migrations apply cruisemesh-web --remote
ALTER TABLE purchases ADD COLUMN renewal_of TEXT;
CREATE INDEX purchases_renewal_of ON purchases (renewal_of);
