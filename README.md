# CruiseMesh Web

Public landing pages and verified app-link association files for
[`cruisemesh.app`](https://cruisemesh.app).

The landing pages are static with no analytics, cookies, accounts, or
server-side friend-card processing. Friend-card payloads (`#CMFRIEND1:...`)
and relay setup cards (`#CMRELAY1:...`) live in URL fragments, which browsers
do not send to Cloudflare.

A small Worker (`src/index.js`) additionally powers the **Cruise Pass**
hosted-relay purchase flow: Stripe Checkout, the Stripe webhook, relay
provisioning, and credential delivery. See [monetize-plan.md](monetize-plan.md)
for the full design and the "Cruise Pass setup" section below for the
one-time launch checklist.

## Local development

```sh
npm install
npm run check
npm run dev
```

## Deploy

Authenticate Wrangler once, then deploy:

```sh
npx wrangler login
npm run deploy
```

The custom domain is declared in `wrangler.jsonc`; Cloudflare manages its DNS
record and TLS certificate.

## Cruise Pass setup (one-time launch checklist)

The purchase flow ships in this repo but needs these steps before it can take
real payments. Until they are done, the static site and `npm run deploy` keep
working — the `/api/` endpoints just return errors.

1. **D1 database** — already created (`cruisemesh-web`, id in `wrangler.jsonc`).
   Apply the schema:

   ```sh
   npx wrangler d1 migrations apply cruisemesh-web --remote
   ```

2. **Stripe** — create a product ("Cruise Pass") with a one-time price in the
   [Stripe dashboard](https://dashboard.stripe.com), put its `price_...` id in
   `wrangler.jsonc` under `vars.STRIPE_PRICE_ID`, then:

   ```sh
   npx wrangler secret put STRIPE_SECRET_KEY
   ```

3. **Stripe webhook** — in the dashboard add an endpoint for
   `https://cruisemesh.app/api/stripe/webhook` subscribed to
   `checkout.session.completed`, and store its signing secret:

   ```sh
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```

4. **Relay admin API** — deploy the relayd families-table/admin-API work
   (Phase 1 in `monetize-plan.md`, lives in the main cruisemesh repo), then:

   ```sh
   npx wrangler secret put RELAY_ADMIN_TOKEN
   ```

   Until this exists, paid purchases show "activation pending" and Stripe
   retries the webhook until provisioning succeeds.

5. **Email** — credential emails go out through [Resend](https://resend.com).
   Add `cruisemesh.app` as a domain there and apply the DKIM records it gives
   you; merge its SPF `include:` into the domain's **existing single** SPF TXT
   record rather than adding a second one (two SPF records are an RFC 7208
   permerror and quietly wreck deliverability). Then:

   ```sh
   npx wrangler secret put RESEND_API_KEY
   ```

   Sends are rejected until the domain is verified, and skipped entirely while
   the secret is unset — in both cases credential delivery is success-page
   only. Inbound mail (`abuse@`, `support@`) stays on Cloudflare Email
   Routing; only sending moved.

6. Deploy (`npm run deploy`) and run a test purchase with a Stripe test key
   before switching the secrets to live keys.

## Association identifiers

- Android package: `com.cruisemesh.app`
- Android release certificate SHA-256:
  `98:9A:75:41:EB:7A:60:EB:8E:AE:58:81:95:C1:EF:1E:A2:FF:6A:0C:E7:EC:43:B9:84:5A:33:EE:8A:B5:07:E7`
- Apple application identifier: `DDS64SNDZH.com.cruisemesh.app`

When the production signing certificate or Apple Team ID changes, update the
files under `dist/.well-known/` before releasing the corresponding app.

