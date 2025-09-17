# COI Disclosure FHIR façade (Bun + Elysia + React)

This revision exposes a minimal FHIR façade for Conflict of Interest (COI) disclosures. All data is kept as raw JSON FHIR resources in SQLite, and the React single-page app reads/writes QuestionnaireResponses using OAuth2 (Authorization Code + PKCE).

- Backend: Bun + Elysia + `bun:sqlite`
- Data model: single `resources` table storing full FHIR JSON
- Resource types: `Questionnaire`, `QuestionnaireResponse`
- Frontend: static React SPA that talks to `/fhir`

## Setup

1. Install Bun (https://bun.sh) and run `bun install`
2. Copy env vars: `cp .env.sample .env` and edit as needed
3. Start the server: `bun run src/server.ts`
4. Visit `http://localhost:3000`

The server seeds the canonical HL7 COI Questionnaire on first boot and serves the SPA from `/frontend/index.html`. No separate build step is required.

## Authentication

- `MOCK_AUTH=true` (default in `.env.sample`) enables an in-process mock OIDC provider at `/mock-oidc`. The SPA still runs an Authorization Code + PKCE flow; the mock `authorize` endpoint simply reflects a `mock_jwk_claims` parameter (base64url JSON) into the authorization `code` and the token response, so you can supply any claims you need when testing.
- With `MOCK_AUTH=false`, supply `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_AUDIENCE`, and `OIDC_REDIRECT_URI`. The SPA performs Authorization Code + PKCE and exchanges the code for tokens. The Bun server validates access tokens via JWKS using `jose`.

## FHIR API surface

- `GET /fhir/Questionnaire` – supports `url`, `version`, `status`, `_id`
- `GET /fhir/QuestionnaireResponse` – supports `subject:identifier`, `status`, `questionnaire`, `authored`
- `POST /fhir/{type}` and `PUT /fhir/{type}/{id}` – latest write wins, no `_history`

QuestionnaireResponses include `item.text` copied from the Questionnaire so that every response renders independently of the canonical form. Searches are backed by JSON expression indexes tailored to the supported parameters.

## Environment variables

- `APP_BASE_URL` – base URL reported to the SPA (defaults to `http://localhost:3000`)
- `PORT` – server port (`3000` by default)
- `MOCK_AUTH` – set to `false` to require real OIDC tokens
- `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_AUDIENCE`, `OIDC_REDIRECT_URI` – required when `MOCK_AUTH=false`

## Development notes

- All FHIR data lives in `./data/fhir.db`
- CSV/static-site generation from earlier iterations has been removed
- Type-check with `bunx tsc --noEmit`

Extend the façade with additional resource types or search parameters as needed for your workflow.
