# CruiseMesh Relay Monetization Plan

Goal: a visitor lands on cruisemesh.app, pays with Stripe, and immediately
receives a working relay URL + key — on the success page and by email — that
their whole family can use with zero manual server setup.

This plan covers every component across both repos:

- **`../cruisemesh`** — the app + `relayd` server (Rust/Axum/SQLite)
- **`CruiseMesh-web`** — this repo: static site on Cloudflare Workers assets

## Where we are today

| Piece | Current state |
| --- | --- |
| relayd auth | Static comma-separated bearer tokens in `CRUISEMESH_RELAY_TOKENS` env var; adding a family = edit env + restart (`relayd/src/main.rs:20-24`) |
| Tenancy | Every row keyed by `family_token`; queries fully scoped per tenant — the isolation model is already right |
| Quota | One global `CRUISEMESH_RELAY_FAMILY_QUOTA_BYTES` (256 MiB default), not per-family |
| Provisioning / billing | None anywhere |
| Relay config delivery to phones | Only inside friend cards (`relay_url` + `relay_token` fields in `CMFRIEND2:` tokens, opened via `https://cruisemesh.app/f#...`) |
| Website | 100% static assets, no Worker logic, privacy page promises "no accounts, no server-side processing" |
| Deployment | Single VPS via `relayd/docker-compose.yml` (relayd + Caddy TLS) |

The one primitive everything builds on: **a purchase = one freshly generated
family token provisioned on a hosted relay.** The buyer imports it once; friend
cards already propagate it to the rest of the family automatically
(`RelayImport.reconcileOnImport` adopts the card's relay as fallback).

## The end-to-end flow we're building

1. Visitor clicks **"Get a hosted relay"** on cruisemesh.app → pricing page.
2. Checkout button → Cloudflare Worker creates a **Stripe Checkout Session** → Stripe-hosted payment page.
3. Stripe webhook (`checkout.session.completed`) → Worker generates a random family token, calls relayd's new **admin API** to provision it, stores the record in **D1**, and emails the customer.
4. Customer lands on `/relay/success?session_id=...` → Worker verifies the session with Stripe and shows the relay URL + key with:
   - a **one-tap setup link** (`https://cruisemesh.app/r#CMRELAY1:...`) that opens the app and configures the relay directly, and
   - the raw URL/token with copy buttons as fallback.
5. The email contains the same setup link + token.
6. Buyer's app is configured; sharing friend cards spreads the relay to the family (already works today).
7. Renewals, cancellations, and expiry flow from Stripe webhooks → relayd admin API (suspend/reactivate/revoke).

---

## Component 1 — relayd: dynamic tenancy + admin API (`../cruisemesh/relayd`)

This is the "relayd families-table / Step 1" work already named in
`PRIVATE-BACKLOG.md`. It's the prerequisite for everything else.

### 1a. Families table

New table in the existing SQLite DB (or a separate control DB):

```sql
CREATE TABLE families (
  token         TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'active',  -- active | suspended | revoked
  quota_bytes   INTEGER,                          -- NULL = server default
  plan          TEXT,                             -- e.g. 'cruise-pass-30d', 'annual'
  created_ms    INTEGER NOT NULL,
  expires_ms    INTEGER,                          -- NULL = no expiry
  note          TEXT                              -- support breadcrumbs (e.g. Stripe customer id)
);
```

- Token validation reads this table (with a small in-memory cache) instead of the env-var `HashSet`. Keep `CRUISEMESH_RELAY_TOKENS` working as a bootstrap/legacy path so existing self-hosters see zero change.
- Per-family `quota_bytes` overrides the global default in `insert_envelope_with_quota`.

### 1b. Admin API

New routes, guarded by a separate `CRUISEMESH_RELAY_ADMIN_TOKEN` (and ideally
bound so Caddy only exposes them on an internal path or not at all —
the Worker calls over HTTPS with the admin bearer):

- `POST /admin/families` — provision `{token, plan, quota_bytes, expires_ms}`
- `PATCH /admin/families/:token` — change status (suspend/reactivate), extend `expires_ms` on renewal, adjust quota
- `DELETE /admin/families/:token` — revoke + purge stored envelopes
- `GET /admin/families/:token` — status + storage usage (for support and a future "manage" page)

All idempotent (provisioning the same token twice is a no-op) so webhook
retries are safe.

### 1c. Expiry semantics + client-visible error

- Expired/suspended families get a distinct error, e.g. HTTP 403 `{code:"family_expired"}` — different from plain bad-token 401 — so apps can show "Your relay pass has expired" with a renew link instead of a generic failure.
- Grace period decision: suggest **7 days read-only** (can fetch queued messages, can't post new ones) after expiry, then full suspension; purge data 30 days after revocation.

### 1d. Basic per-token rate limiting

There is currently none. Add a simple token-bucket per family (requests/min
and bytes/min) so one paying customer can't degrade the box for others. Keep
limits generous; this is abuse protection, not tiering.

### 1e. AGPL note

relayd is AGPL-3.0. That's fine — the business is **hosting**, not licensing.
The admin-API and families-table code should simply be committed to the public
repo like the rest (network users are entitled to source anyway under AGPL §13,
and "self-hostable, open source" stays true as a brand promise). Nothing
secret goes in relayd; secrets live in env vars and the Worker.

---

## Component 2 — Payments + provisioning Worker (`CruiseMesh-web`)

The site gains its first real server logic. Add a Worker (`src/index.js`) that
serves the existing static assets *and* handles a small API, plus a **D1**
database and Worker **secrets** (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`RELAY_ADMIN_TOKEN`).

### 2a. Routes

- `POST /api/checkout` — creates a Stripe Checkout Session (price id from config), `success_url = https://cruisemesh.app/relay/success?session_id={CHECKOUT_SESSION_ID}`. Optionally protect with Turnstile to stop bot-driven session spam.
- `POST /api/stripe/webhook` — verifies the Stripe signature, then handles:
  - `checkout.session.completed` → generate token (32 random bytes, hex — same format `DEPLOY.md` recommends), call relayd `POST /admin/families`, insert D1 row, send the delivery email. Idempotent on `session_id`.
  - `invoice.paid` (subscriptions) → extend `expires_ms` via `PATCH`.
  - `invoice.payment_failed` / `customer.subscription.deleted` → suspend/revoke.
- `GET /relay/success` (or an API the success page calls) — verifies the `session_id` against Stripe *server-side*, looks up the token in D1, renders the credentials page. Never render credentials for an unpaid/unknown session.
- `GET /api/portal` — creates a Stripe **customer portal** session so subscribers can self-serve cancel/update card (link it from the email).

### 2b. D1 schema

```sql
CREATE TABLE purchases (
  session_id     TEXT PRIMARY KEY,   -- Stripe checkout session (idempotency key)
  customer_id    TEXT,               -- Stripe customer
  subscription_id TEXT,
  email          TEXT NOT NULL,
  family_token   TEXT NOT NULL,
  relay_url      TEXT NOT NULL,      -- which relay host they were placed on
  plan           TEXT NOT NULL,
  status         TEXT NOT NULL,      -- active | expired | canceled
  created_ms     INTEGER NOT NULL
);
```

This is the system of record linking Stripe ⇄ token ⇄ relay host, and what
support uses to answer "I lost my key."

### 2c. Email delivery

Use **Cloudflare Email Service** (Workers binding) to send from
`pass@cruisemesh.app` (needs SPF/DKIM/DMARC set up on the zone — do this early;
deliverability of a mail containing a "key" is make-or-break). Email contains:

- the one-tap setup link (`https://cruisemesh.app/r#CMRELAY1:...`),
- the relay URL + token in plain text as fallback,
- setup steps ("open on your phone with CruiseMesh installed"),
- manage-subscription (portal) and support links.

Privacy note: the token transits email and is stored in D1/Stripe metadata —
acceptable for this product (it's a mailbox access token, not an E2E key), but
say so plainly in the updated privacy policy. Keep the token out of URLs'
query/path everywhere; the setup link uses a `#fragment` exactly like `/f`, so
it never hits server logs.

### 2d. Config split

Today `wrangler.jsonc` is assets-only. Add the Worker entrypoint (`main`), D1
binding, email binding, and keep `run_worker_first` limited to `/api/*` and
`/relay/success` so the static site keeps its current zero-latency asset
serving.

---

## Component 3 — New link format + app support (`../cruisemesh`)

Relay config currently travels **only** inside friend cards. The buyer
themselves has no card to import, so we need a standalone relay-config link:

### 3a. `CMRELAY1:` token + `/r` deep link

- Define `CMRELAY1:` + base64url-nopad of `{relay_url, relay_token}` in core (mirror the `CMFRIEND2` binary style: `opt(relay_url) ‖ opt(relay_token)` with the same length-prefixed encoding, reuse the existing 2 KiB / 1 KiB validation limits from `identity.rs`).
- Web link: `https://cruisemesh.app/r#CMRELAY1:...` — fragment-carried like `/f`, so the secret never reaches Cloudflare.
- Android: extend `MainActivity.deepLinkFromIntent` + the App Link intent-filter (`pathPrefix=/r`) to parse it and write `RelayConfigStore`; show a confirm sheet ("Use relay.cruisemesh.app for message delivery?").
- iOS: same via Universal Links + `RelayConfigStore.swift`.

### 3b. Expired-pass UX

Handle the new `family_expired` error code in `RelayClient` (both platforms):
banner/status in settings — "Relay pass expired — renew" linking to the portal
page. Without this, a lapsed subscription looks like a mysterious outage.

### 3c. (Later) In-app purchase surface

A "Get a hosted relay" button in app settings that opens the pricing page in a
browser. **Careful:** Apple's rules around digital-service purchases —
steering to external purchase from inside the iOS app has policy implications.
Safest v1: the website sells, the app only *consumes* links; don't link out to
the purchase page from inside the iOS app until the policy question is
reviewed.

---

## Component 4 — Website pages (`CruiseMesh-web`)

- **`/relay` (or `/pass`) pricing page** — what a hosted relay does, what's included (storage quota, retention, family-wide coverage via friend cards), price, checkout button. Reuse the existing card design.
- **Landing page CTA** — the "Optional internet relay" section on `/` gets a "or get a hosted one" link.
- **`/r` fragment page** — sibling of `/f`: shows the `CMRELAY1` token, copy button, "open in app" guidance for when the App Link doesn't fire.
- **`/relay/success`** — Worker-rendered credentials page (see 2a).
- **Privacy policy update** — the current page (and README) promise no accounts, cookies, or server-side processing. That stays true for the *messaging* product but must be amended for the purchase flow: Stripe processes payment data, we store email + token, we send email. Be explicit and keep the "friend cards never reach our servers" guarantee intact.
- **Terms of service + refund policy** page — required by Stripe and common sense. Enable **Stripe Tax** for VAT/sales-tax handling.
- **Branding decision (flag):** `PRIVATE-BACKLOG.md` stages "Cruise Pass" copy for **cruisemesh.com**, but everything live is on **cruisemesh.app**. Recommend selling on cruisemesh.app (`/pass`) — one domain, and the app-link association is already there; use cruisemesh.com as a redirect (the redirect Worker already exists).

---

## Component 5 — Relay fleet operations

- **Host:** start with the existing docker-compose deploy on one VPS at `relay.cruisemesh.app` (Caddy already does TLS). The admin API is the only addition. One box at family-scale traffic will go a long way; `relay_url` stored per purchase in D1 means adding a second host later is just a routing decision at provisioning time.
- **Backups:** nightly SQLite snapshot off-box (the runbook already documents copy-the-file). Now that people pay, this becomes non-optional.
- **Monitoring:** uptime check on `/healthz` (e.g. a Cloudflare Worker cron pinging it + email alert), disk-usage alert, and a weekly job reconciling D1 purchases against relayd's families table to catch drift from missed webhooks.
- **Capacity model:** 256 MiB default quota per family; a 100 GB disk comfortably holds ~350 families even at full quota. Envelope retention (30-day max) keeps this self-pruning.

## Pricing (decision needed)

Two shapes fit the "cruise" use case; suggest launching with both:

1. **Cruise Pass** — one-time, 30 days, covers the whole family (one token). Impulse-purchase price point, e.g. **$9.99**. Matches the backlog's "one Cruise Pass covers the family" upsell framing. No subscription mechanics needed (just `expires_ms`).
2. **Annual family plan** — subscription, e.g. **$29/yr**, for families who keep the relay year-round.

Launching with (1) only is the simplest possible v1: no `invoice.paid`
handling, no portal, no cancellation flow — just expiry.

## Phasing

**Phase 1 — relayd foundation** (unblocks everything)
Families table, DB-backed token validation, admin API, per-family quota,
`family_expired` error code. Deploy to the VPS behind the existing compose setup.

**Phase 2 — purchase pipeline**
Worker + D1 + Stripe Checkout (one-time Cruise Pass only) + webhook +
success page + email (with SPF/DKIM set up). At the end of this phase money
in → working token out, delivered by email and success page.

**Phase 3 — one-tap setup**
`CMRELAY1:` in core, `/r` page, Android + iOS deep-link handling, expired-pass
UX in apps. Until this ships, the success page/email show manual copy-paste
setup (Settings → Relay → paste URL and token), which works today.

**Phase 4 — subscriptions + polish**
Annual plan, Stripe portal, renewal/cancellation webhooks, grace-period
enforcement, ToS/refund pages, Stripe Tax, reconciliation cron, monitoring.

**Phase 5 — growth (later)**
Second relay region, in-app purchase surface (post Apple-policy review),
"resend my key" self-service lookup, gift links.

## Open decisions

1. Pricing/plan shape (see above) — gate on this before Phase 2.
2. Sell on cruisemesh.app vs cruisemesh.com (recommendation: .app).
3. Grace-period policy (suggested: 7 days read-only, purge at +30).
4. Whether Phase 1's admin API lands in the public relayd repo (recommended: yes, AGPL makes hiding it pointless and openness is on-brand).
