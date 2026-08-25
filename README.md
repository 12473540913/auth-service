# Shared Auth Service

Shared auth and encrypted app-progress service for all your apps.

## Stack

- Express
- MongoDB Atlas (Mongoose)
- Resend
- JWT in HttpOnly cookie

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

Entry status is implemented by the `@data/user-db` workspace package and stored in the `UserEntryStatus` collection as one document per user and media entry:

```json
{
	"userId": "ObjectId(User)",
	"entryId": "static-db-entry-id",
	"viewed": true,
	"rating": 4
}
```

The collection has a unique `{ userId, entryId }` index for quick per-user entry lookup and a `{ entryId, userId }` index for entry-centered queries.

## Run

1. Copy `.env.example` to `.env` and fill values.
2. `pnpm -C services/auth-service install`
3. `pnpm -C services/auth-service dev`
