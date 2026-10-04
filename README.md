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
| `mongodb` | [src/store/mongo.ts](src/store/mongo.ts) | Any configured tenant |
| `postgres` | [src/store/postgres.ts](src/store/postgres.ts) | Any configured tenant |

The driver is inferred from the connection string's scheme (`mongodb://`, `mongodb+srv://`,
`postgres://`, `postgresql://`), so the variable name is only a naming convention.

Ids are opaque strings: an ObjectId hex string on Mongo, a uuid on Postgres. The Postgres
store creates its tables on first connect with `CREATE TABLE IF NOT EXISTS`, so no separate
migration step is needed.

Optional features may be supported by only some stores. Incompatible feature and store
configurations fail at startup rather than surfacing as runtime errors.

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
- `GET /auth/progress/:appId/blob`
- `PUT /auth/progress/:appId/blob`

Progress blobs are opaque ciphertext generated client-side. Additional routes can be
enabled for configured tenants when their stores support them.

## Registering an app

Apps are config-only; adding one needs no code change. Replace `<APP>` with the app ID
normalized to uppercase with non-alphanumeric characters replaced by underscores:

| Variable | Purpose |
| --- | --- |
| `AUTH_APP_IDS` | Allowlist of accepted `X-App-Id` values. An id not listed here is rejected. |
| `ATLAS_URI_<APP>` | Tenant connection string. `NEON_URI_`, `DATABASE_URI_` and `MONGODB_URI_` prefixes are also accepted. |
| `AUTH_ORIGINS_<APP>` | Comma-separated browser origins allowed by CORS. |
| `AUTH_TOKEN_MODE_<APP>` | `cookie` for web apps, `bearer` for native clients. |
| `AUTH_COOKIE_SAMESITE_<APP>` | Per-app cookie `SameSite`. Defaults to `lax`. |
| `AUTH_APP_NAME_<APP>` | Display name used in verification emails. |
| `AUTH_FEATURES_<APP>` | Optional feature routes supported by the tenant's configured store. |

Every registered app is validated at startup, so a missing connection string fails the
deploy instead of surfacing as an error on the first request.

### Environments

`AUTH_ENV` (`dev` / `prod`) is a property of the deployment, never of the request. A
production service should receive only production connection strings, so a client cannot
reach development data by changing a header. Run development and production as separately
configured services, each with its own credentials and secrets.

### Cookies and SameSite

`AUTH_COOKIE_SAMESITE_<APP>` (default `lax`) is per app, because whether a cookie is
cross-site depends on the app's domain, not on this service.

An app and auth service under the same registrable domain make *same-site* requests, for
which `lax` is sufficient — and retains the CSRF protection that `none` gives up. An app
served from an unrelated domain needs `none`, and browsers reject `SameSite=None` unless
the cookie is also `Secure`.

When browser apps and the auth service use unrelated domains, set
`AUTH_COOKIE_SAMESITE_<APP>=none`. Switch those browser apps back to `lax` if their auth
base URL later moves to a host under the same registrable domain.

Native clients skip cookies entirely, so this setting does not apply to them.

### Native clients

Native clients that do not have a usable browser cookie jar can use `bearer` mode:

- `POST /auth/signin` returns `{ token }` in the response body.
- Store the token using the native platform's secure storage, not browser `localStorage`.
- Send it as a bearer token alongside the `X-App-Id` header.
- Configure allowed browser origins as appropriate for the client architecture.

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
  --set-env-vars AUTH_ENV=prod,NODE_ENV=production,AUTH_APP_IDS=app-one+app-two \
  --set-secrets JWT_SECRET=auth-jwt-secret:latest,ATLAS_URI_APP_ONE=app-one-database-uri:latest,NEON_URI_APP_TWO=app-two-database-uri:latest
```

Notes:

- Cloud Run injects `PORT`; the server binds `0.0.0.0` on whatever it receives.
- `--set-env-vars` uses `,` as a separator, so escape lists with `+` or use `^@^`.
- The database must allow Cloud Run egress. Either allow `0.0.0.0/0` or attach a VPC connector
  with a static NAT IP and allowlist that.
- `SIGTERM` drains in-flight requests and closes database connections.

### Custom domain

```sh
gcloud beta run domain-mappings create \
  --service auth-service \
  --domain auth.example.com \
  --region us-central1
```

Then add the DNS records the command prints. Configure a separate development service and
domain as needed.

Domain mappings are unavailable in some regions; a global external HTTPS load balancer
with a serverless NEG is the fallback.

## Roadmap

Keep the service focused on identity and capabilities that genuinely need to be shared.
Optional product-specific features should be explicitly enabled and supported by the
tenant's configured store. As application-owned data grows, move it to the application
backend where it can be modeled and maintained by its owners. Opaque client-encrypted
blobs illustrate a narrower shared-storage role: the service persists the data without
interpreting its contents.
