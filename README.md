# CruiseMesh Web

Public landing pages and verified app-link association files for
[`cruisemesh.app`](https://cruisemesh.app).

The site is intentionally static and contains no analytics, cookies, accounts,
or server-side friend-card processing. Friend-card payloads live in URL
fragments (`#CMFRIEND1:...`), which browsers do not send to Cloudflare.

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

## Association identifiers

- Android package: `com.cruisemesh.app`
- Android release certificate SHA-256:
  `98:9A:75:41:EB:7A:60:EB:8E:AE:58:81:95:C1:EF:1E:A2:FF:6A:0C:E7:EC:43:B9:84:5A:33:EE:8A:B5:07:E7`
- Apple application identifier: `DDS64SNDZH.com.cruisemesh.app`

When the production signing certificate or Apple Team ID changes, update the
files under `dist/.well-known/` before releasing the corresponding app.

