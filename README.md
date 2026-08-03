# CruiseMesh Web

Public landing pages and verified app-link association files for
[`cruisemesh.app`](https://cruisemesh.app).

The landing pages are static with no analytics, cookies, accounts, or
server-side friend-card processing. Friend-card payloads (`#CMFRIEND1:...`)
and relay setup cards (`#CMRELAY1:...`) live in URL fragments, which browsers
do not send to Cloudflare.

A small Worker (`src/index.js`) additionally powers the **Cruise Pass**
hosted-relay purchase flow: Stripe Checkout, the Stripe webhook, relay
provisioning, and credential delivery. It is live and taking real payments;
the "Cruise Pass" section below is the operator's reference for it.

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

## Cruise Pass

The purchase flow is live. What follows is what each piece is and how to
re-establish it — on a new account, or when a credential has to be rotated.
The static site and `npm run deploy` keep working regardless; without these,
the `/api/` endpoints simply return errors.

1. **D1 database** — `cruisemesh-web`, id in `wrangler.jsonc`. To apply the
   schema (migrations are idempotent):

   ```sh
   npx wrangler d1 migrations apply cruisemesh-web --remote
   ```

2. **Stripe** — a product ("Cruise Pass") with a one-time price, whose
   `price_...` id lives in `wrangler.jsonc` under `vars.STRIPE_PRICE_ID`. The
   price id and the secret key must be swapped in the same breath: a live key
   with a test price, or the reverse, fails checkout with "no such price".

   ```sh
   npx wrangler secret put STRIPE_SECRET_KEY
   ```

3. **Stripe webhook** — an endpoint for
   `https://cruisemesh.app/api/stripe/webhook` subscribed to
   `checkout.session.completed` and `checkout.session.async_payment_succeeded`
   (`src/index.js` handles both), and its signing secret:

   ```sh
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```

   The webhook is what fulfills a buyer who closes the tab at Stripe instead of
   returning to the success page. Both paths call the same idempotent
   `fulfillCheckoutSession`, so either one alone completes a purchase — but
   only the webhook covers the buyer who never comes back.

4. **Relay admin API** — the families-table admin API in the main cruisemesh
   repo (`relayd`, see its `DEPLOY.md`) must be deployed and reachable, then:

   ```sh
   npx wrangler secret put RELAY_ADMIN_TOKEN
   ```

   Until this exists, paid purchases show "activation pending" and Stripe
   retries the webhook until provisioning succeeds.

5. **Email** — credential emails go out through [Resend](https://resend.com)
   with `cruisemesh.app` verified as a sending domain: DKIM at
   `resend._domainkey`, and the Return-Path on the `send.cruisemesh.app`
   subdomain with its own `include:amazonses.com` SPF record. Keeping the
   envelope sender on that subdomain is what leaves the apex SPF record free
   for Cloudflare Email Routing — never add a second SPF TXT record to the
   apex, because two are an RFC 7208 permerror that quietly wrecks
   deliverability. Then:

   ```sh
   npx wrangler secret put RESEND_API_KEY
   ```

   Sends are rejected until the domain is verified, and skipped entirely while
   the secret is unset — in both cases credential delivery is success-page
   only. Inbound mail (`abuse@`, `support@`) stays on Cloudflare Email
   Routing; only sending moved.

6. Deploy the site with `npm run deploy`. The alias hostnames
   (`cruisemesh.com`, both `www.` forms) are a separate Worker with its own
   deploy, `npm run deploy:redirect`; a hostname added to
   `wrangler.redirect.jsonc` gets its DNS record and certificate from that
   deploy and needs no dashboard step.

## Renewing a pass

Renewing **extends the pass a family already has, on the same family token**.
That is the whole feature: the setup card does not change, so no phone is set
up a second time. A renewal that minted a fresh token would just be a second
purchase wearing the word "renew", and the family would discover that mid-trip.

There are no accounts, so ownership is proved the way it was established — by
the address that bought the pass. A one-time code (`renewals` table) is mailed
to it and says which pass a checkout extends. The code is not the family token
and grants no access to messages: the worst a stolen one can do is let a thief
pay to extend somebody else's pass.

Two ways in, one mechanism:

- the expiry reminder (`src/ops.js`) carries a ready-made link, so the common
  case is one tap from the email that says the pass is running out;
- `/pass/renew/` takes an address and mails a fresh link. It answers
  identically whether or not that address has a pass, so it cannot be used to
  ask whether someone is a customer, and `issueRenewalCode` rate-limits sends
  to one per pass per hour so the form cannot flood an inbox.

Fulfillment (`src/fulfill.js`) then runs the ordinary three steps with one
difference: it reuses the family token of the pass being renewed and extends
from that pass's paid-through date, so renewing early costs no days. The relay's
`POST /admin/families` upserts on the token, so provisioning moves the existing
family's expiry rather than creating a second one. The superseded row moves to
`status = 'renewed'` — that is what stops the expiry reminder mailing about a
date already paid past, and keeps reconciliation reading the live row.

A renewal link that no longer resolves (expired between checkout and payment)
falls back to issuing a normal new pass rather than failing: the customer paid,
so they get a working pass either way, and the credential email explains the
setup that one needs.

Renewal adds no secrets and no cron. It does need `migrations/0004_renewal.sql`
applied before deploy:

```sh
npx wrangler d1 migrations apply cruisemesh-web --remote
```

## Association identifiers

- Android package: `com.cruisemesh.app`
- Android release certificate SHA-256:
  `98:9A:75:41:EB:7A:60:EB:8E:AE:58:81:95:C1:EF:1E:A2:FF:6A:0C:E7:EC:43:B9:84:5A:33:EE:8A:B5:07:E7`
- Apple application identifier: `DDS64SNDZH.com.cruisemesh.app`

When the production signing certificate or Apple Team ID changes, update the
files under `dist/.well-known/` before releasing the corresponding app.

