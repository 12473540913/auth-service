# Shared Auth Service

Shared auth and encrypted app-progress service for all your apps. A single deployment
serves many apps; each request carries an `X-App-Id` header that selects the tenant
database.

## Stack

- Express
- MongoDB Atlas (Mongoose) **or** Postgres/Neon (`pg`), chosen per app
- Resend
- JWT, delivered as an HttpOnly cookie (web) or a Bearer token (native)

## Storage drivers

Routes never touch a database driver directly. They talk to the `TenantStore` interface in
[src/store/types.ts](src/store/types.ts), which has two implementations:

| Driver | Implementation | Used by |
| --- | --- | --- |
| `mongodb` | [src/store/mongo.ts](src/store/mongo.ts) | `spice` (Atlas) |
| `postgres` | [src/store/postgres.ts](src/store/postgres.ts) | `finances` (Neon) |

The driver is inferred from the connection string's scheme (`mongodb://`, `mongodb+srv://`,
`postgres://`, `postgresql://`), so the variable name is only a naming convention.

Ids are opaque strings: an ObjectId hex string on Mongo, a uuid on Postgres. The Postgres
store creates its tables on first connect with `CREATE TABLE IF NOT EXISTS`, so no separate
migration step is needed.

`entry-status` is implemented only by the Mongo store; enabling it on a Postgres tenant
fails at startup rather than 404-ing after deploy.

## Endpoints

- `POST /auth/signup`
- `POST /auth/signin`
- `POST /auth/signout`
- `GET /auth/session`
- `POST /auth/verify/request`
- `GET /auth/verify/confirm`
- `POST /auth/password-reset/request`
- `GET /auth/password-reset/confirm`
- `POST /auth/password-reset/confirm`
- `GET /auth/entries/status?entryIds=:entryId,:entryId`
- `GET /auth/entries/:entryId/status`
- `PATCH /auth/entries/:entryId/status`
- `GET /auth/progress/:appId/blob`
- `PUT /auth/progress/:appId/blob`

Progress blob is opaque ciphertext generated client-side.

## Registering an app

Apps are config-only; adding one needs no code change. For an app id `spice`:

| Variable | Purpose |
| --- | --- |
| `AUTH_APP_IDS` | Allowlist of accepted `X-App-Id` values. An id not listed here is rejected. |
| `ATLAS_URI_SPICE` | Tenant connection string. `NEON_URI_`, `DATABASE_URI_` and `MONGODB_URI_` prefixes are also accepted. |
| `AUTH_ORIGINS_SPICE` | Comma-separated browser origins allowed by CORS. |
| `AUTH_TOKEN_MODE_SPICE` | `cookie` for web apps, `bearer` for native clients. |
| `AUTH_COOKIE_SAMESITE_SPICE` | Per-app cookie `SameSite`. Defaults to `lax`. |
| `AUTH_APP_NAME_SPICE` | Display name used in verification emails. |
| `AUTH_FEATURES_SPICE` | Opt-in feature routes, e.g. `entry-status` (mongodb only). |

Every registered app is validated at startup, so a missing connection string fails the
deploy instead of surfacing as an error on the first request.

### Environments

`AUTH_ENV` (`dev` / `prod`) is a property of the deployment, never of the request. A prod
service is configured only with prod connection strings, so a client cannot reach dev data
by changing a header. Run dev and prod as two Cloud Run services:

| Stage | Host |
| --- | --- |
| Production | `auth.lnks.info` |
| Development, active now | `auth-dev-46917854791.us-central1.run.app` |
| Development, later custom domain | `auth-dev.lnks.info` |

Until the custom domain mapping is complete, dev clients should use:

```txt
https://auth-dev-46917854791.us-central1.run.app
```

Keep `https://auth-dev.lnks.info` commented out in client config for now; it is the long-term
dev host, but not the currently working endpoint.

### Cookies and SameSite

`AUTH_COOKIE_SAMESITE_<APP>` (default `lax`) is per app, because whether a cookie is
cross-site depends on the app's domain, not on this service.

An app under `*.lnks.info` shares a registrable domain with the auth service, so its
requests are *same-site* and `lax` is sufficient — which also keeps CSRF protection that
`none` gives up. Only an app served from an unrelated domain needs `none`, and browsers
reject `SameSite=None` unless the cookie is also `Secure`.

While development clients point at the default Cloud Run `run.app` host, browser apps are
cross-site and need `AUTH_COOKIE_SAMESITE_<APP>=none`. Switch those browser apps back to
`lax` after their auth base URL moves to the `lnks.info` custom domain.

Native clients skip cookies entirely, so this setting does not apply to them.

### Native clients (Electron)

An Electron app has no usable cross-site cookie jar, so `spice` uses `bearer` mode:

- Dev auth base URL for UI end-to-end testing: `https://auth-dev-46917854791.us-central1.run.app`.
- Keep the pending custom dev host, `https://auth-dev.lnks.info`, commented out until domain mapping is done.
- `POST /auth/signin` returns `{ token }` in the response body.
- Store it with Electron's `safeStorage`, not `localStorage`.
- Send it as `Authorization: Bearer <token>` alongside `X-App-Id: spice`.
- Issue requests from the main process. They carry no `Origin` header and bypass CORS.

Web apps stay on cookies and must use `credentials: "include"`.

## Run locally

1. `cp .env.example .env.development` and fill in the values.
2. `pnpm install`
3. `pnpm dev`

## Deploy to Cloud Run

Secrets belong in Secret Manager, not in the service's plain environment variables.

```sh
gcloud run deploy auth-service \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars AUTH_ENV=prod,NODE_ENV=production,AUTH_APP_IDS=spice+finances \
  --set-secrets JWT_SECRET=auth-jwt-secret:latest,ATLAS_URI_SPICE_PROD=spice-atlas-uri:latest,NEON_URI_FINANCES_PROD=finances-neon-uri:latest
```

Notes:

- Cloud Run injects `PORT`; the server binds `0.0.0.0` on whatever it receives.
- `--set-env-vars` uses `,` as a separator, so escape lists with `+` or use `^@^`.
- Atlas must allow Cloud Run egress. Either allow `0.0.0.0/0` or attach a VPC connector
  with a static NAT IP and allowlist that.
- `SIGTERM` drains in-flight requests and closes Mongo connections.

### Custom domain

```sh
gcloud beta run domain-mappings create \
  --service auth-service \
  --domain auth.lnks.info \
  --region us-central1
```

Then add the DNS records the command prints. Deploy the dev service the same way under
`auth-dev.lnks.info`. Until that mapping is finished, leave custom-domain client config
commented out and point dev clients at the default Cloud Run URL:
`https://auth-dev-46917854791.us-central1.run.app`.

Domain mappings are unavailable in some regions; a global external HTTPS load balancer
with a serverless NEG is the fallback.

## Roadmap

`/auth/entries/*` and `UserAppSettings.contentRoot` are Spice domain concepts living in a
generic auth service. They are fenced off behind `AUTH_FEATURES_<APP>` so other tenants
never load them, but the better end state is for Spice to own that data in its own backend
and use this service only for identity. `UserAppBlob` already models that pattern well: the
service stores opaque client-encrypted ciphertext and knows nothing about its contents.
