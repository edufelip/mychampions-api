# MyChampions Server

## Browser session boundary

Web clients may opt into `sessionMode: cookie` on email/social sign-in. The response keeps the access token in application memory, explicitly expires any legacy access-token cookie, and sets a rotating HttpOnly refresh cookie. Production requests from an explicitly allowlisted website on a different origin receive `Secure; SameSite=None`; same-origin and local-development sessions retain `SameSite=Lax`. `POST /auth/session/refresh` rotates that cookie, expires any legacy access-token cookie again, and rejects replay. Refresh reads the current profile identity, but preserves `emailVerified` only while the current email still matches the email bound to the verified session. `POST /auth/session/sign-out` attempts to revoke every distinct refresh token presented through the cookie and request body before expiring auth cookies, so a stale hybrid-client cookie cannot leave an explicit native session active. Native clients continue using response-body bearer refresh tokens.

Credentialed browser access is restricted to exact comma-separated `WEB_ALLOWED_ORIGINS`. Development defaults to `http://localhost:8081,http://127.0.0.1:8081`; production defaults to an empty list. This repository contains no website deployment or infrastructure activation.

Local-first backend for MyChampions mobile app-domain logic.

## Stack

- Bun runtime/test runner/package manager
- Elysia HTTP framework
- TypeBox `0.34` schemas through Elysia `t`
- PostgreSQL with tilde-pinned `postgres` `3.4`, Drizzle ORM `0.45`, and `drizzle-kit` migrations
- JOSE `6` RS256 JWT signing and JWKS
- Google Cloud Storage client for private production media storage

## Local Setup

The server stack is pinned to Bun `1.3.14` through `package.json` and `.bun-version`.

From the parent workspace:

```bash
bun run local:db:up
bun run server:db:migrate
bun run server:test
bun run server:dev
```

The parent `server:*` commands run through `scripts/server-bun.sh`, so they use
the workspace-local `.local-bun/bin/bun` when installed and still enforce
`.bun-version` before entering `server/`.

Default local URL:

```bash
http://localhost:3400
```

Default database:

```bash
DATABASE_URL=postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_server_local
```

Default local food catalog mirror:

```bash
FOOD_CATALOG_DATABASE_URL=postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_food_catalog_local
```

Default local exercise catalog mirror:

```bash
EXERCISE_CATALOG_DATABASE_URL=postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_exercise_catalog_local
```

Provider integrations are explicitly gated. Keep GCS unset for local filesystem storage and configure direct identity audiences only in environments that verify native provider tokens:

```bash
GCS_BUCKET=
STORAGE_GCS_CREDENTIALS_PATH=
STORAGE_GCS_USE_ADC=true
GOOGLE_ANDROID_CLIENT_ID=
GOOGLE_IOS_CLIENT_ID=
GOOGLE_WEB_CLIENT_ID=
APPLE_CLIENT_ID=
APPLE_WEB_CLIENT_ID=
AUTH_JWT_PRIVATE_JWK=
MEAL_PHOTO_ANALYZER=unconfigured
REVENUECAT_SECRET_API_KEY=
REVENUECAT_WEBHOOK_AUTHORIZATION=
REVENUECAT_WEBHOOK_SIGNING_SECRET=
```

`REVENUECAT_SECRET_API_KEY` must be a server-only `sk_*` key. The webhook handler
uses it to read canonical customer state from `GET /v1/subscribers/:app_user_id`
after an authenticated webhook instead of deriving all privileges from one
product-scoped event. Never expose this key through Expo config or a client env.

Local email/password auth is enabled by default and stores Argon2id credentials
in the local Postgres `local_email_auth_credentials` table. Password-reset
requests are written to the local debug outbox until a direct transactional mail
transport is configured. GCS is disabled by default; when `GCS_BUCKET` is set,
the server uses the configured credential path or Application Default
Credentials and keeps objects private behind the API media route.

`AUTH_JWT_PRIVATE_JWK` is a JSON RS256 private JWK used to preserve access-token
verification and refresh-session behavior across server restarts. It is required
when `NODE_ENV=production`; it must be injected as a runtime secret, never
committed. Without it, local development creates and reuses a generated key at
`.local-storage/auth-signing-key.jwk.json`; the file is owner-readable only and
ignored by Git, so local access and refresh sessions survive a server restart.
Do not copy the local development key into a deployed environment.

Meal-photo analysis also fails closed by default. For local-only UI and mobile/server integration testing without remote analyzer credentials, set:

```bash
MEAL_PHOTO_ANALYZER=local_mock
```

The local mock returns a deterministic low-confidence advisory macro estimate. It is not a production nutrition analyzer.

The parent workspace `bun run local:dev` launcher sets this local mock default
for the server process only. Direct `bun run dev` inside `server/` follows your
shell or `.env` value.

## VM Deployment Bootstrap

The production server is designed for the existing `digiocean` VM topology:
Postgres stays loopback-only in `eduwaldo-postgres`, while the server containers
join Docker's external `root_default` network and are exposed only on
`127.0.0.1:3400` and `127.0.0.1:3401`. Nginx is the only public ingress.

Run the database script from this directory first. It defaults to a no-write
dry run and refuses every target other than the approved VM/container/database
names. `--apply` creates only `mychampions_server`, its non-superuser runtime
role, and a read-only catalog-reader role. It writes the generated runtime
secrets to `/opt/mychampions-server/infra/.env` on the VM with mode `0600`.

```bash
bash infra/scripts/provision-vm-db.sh
bash infra/scripts/provision-vm-db.sh --apply
```

The generated env file intentionally leaves GCS and RevenueCat webhook values
empty. Provision the approved production media boundary before deployment. The
GCS script defaults to a no-write dry run and refuses alternate project,
bucket, region, service-account, SSH-host, or VM-secret targets. Its approved
target is the standard private GCS bucket
`gs://mychampions-server-media-942354515358` in `us-west1`, using the billed
MyChampions Google Cloud project only as a GCS control plane. It does not add a
Firebase runtime dependency.

```bash
bash infra/scripts/provision-gcs.sh
bash infra/scripts/provision-gcs.sh --apply
```

`--apply` enforces uniform bucket-level access and public-access prevention,
creates only the dedicated bucket-scoped service account, validates it with an
upload/read/delete smoke, and installs its JSON key at
`/opt/mychampions-server/infra/secrets/mychampions-gcs-service-account.json`.
The credential directory is `0700`; the key and VM env file are `0600`. A
successful run deliberately refuses a second run rather than silently rotating
the deployed credential.

For the first public ingress, point the chosen DNS name to the VM, then use
the guarded bootstrap script. It defaults to a no-write dry run; `--apply`
requires exactly one healthy server slot, verifies DNS against the VM public
address, obtains the Let's Encrypt certificate, and installs the Nginx route
without replacing the running container.

```bash
PUBLIC_DOMAIN=api.mychampions.eduwaldo.com CERTBOT_EMAIL=ops@example.com \
  bash infra/scripts/bootstrap-public-ingress.sh --apply
```

The live endpoint is `https://api.mychampions.eduwaldo.com`. The Nginx route
redirects HTTP to HTTPS, keeps Bun loopback-only, and accepts request bodies up
to 8 MB so the server's meal-photo limit can be enforced by the application.
The bootstrap script does not change RevenueCat dashboard settings.

After those preflights, the deployment script pulls the pinned image, runs
Drizzle migrations, starts the inactive loopback slot, checks `/health`, tests
Nginx, switches the upstream, and stops the old slot. It requires an explicit
immutable image reference and refuses to cut over unless exactly one active
slot is healthy and agrees with the persisted slot marker. It also refuses a
production cutover unless the runtime env contains a server-only RevenueCat
`sk_*` key plus nonblank webhook Authorization and HMAC values:

```bash
PUBLIC_DOMAIN=api.mychampions.eduwaldo.com \
IMAGE_REPOSITORY=<registry/repository> IMAGE_TAG=<immutable-image-tag> \
  bash infra/scripts/deploy-vm.sh
```

For the direct `linux/amd64` image-transfer workflow already used by this VM,
build and verify the image locally, load that exact immutable tag on the VM,
then use the same guarded cutover with `IMAGE_PULL=false`. The script verifies
the image is already present before it runs migrations or starts a slot:

```bash
docker save mychampions-server:<immutable-image-tag> | ssh digiocean docker load
ssh digiocean \
  'PUBLIC_DOMAIN=api.mychampions.eduwaldo.com \
  IMAGE_REPOSITORY=mychampions-server IMAGE_TAG=<immutable-image-tag> IMAGE_PULL=false \
  bash /opt/mychampions-server/infra/scripts/deploy-vm.sh'
```

`IMAGE_PULL` defaults to `true`; only `true` and `false` are accepted. Do not
use `IMAGE_PULL=false` unless the tag was directly loaded and its architecture
and image ID were verified.

`infra/nginx/mychampions-server.conf` expects an existing Let's Encrypt
certificate for `PUBLIC_DOMAIN`; it redirects HTTP to HTTPS and proxies both
the health route and API traffic to the active loopback slot.

## Current API Slice

The current local migration slice covers mobile server boundaries now owned by the MyChampions server:

- `GET /health`
- `GET /.well-known/jwks.json`
- `POST /auth/dev/session`
- `POST /auth/email/sign-in`
- `POST /auth/email/create-account`
- `POST /auth/social/sign-in`
- `POST /auth/password-reset`
- `GET /me`
- `POST /subscription/entitlements/snapshot`
- `POST /webhooks/revenuecat`
- `PATCH /me/role`
- `PATCH /me/terms`
- `POST /me/hydrate`
- `DELETE /me`
- `GET /connections`
- `POST /connections/:connectionId/confirm`
- `POST /connections/:connectionId/end`
- `GET /professional/invite-codes/:specialty`
- `POST /professional/invite-codes/:specialty/rotate`
- `GET /professional/specialties`
- `POST /professional/specialties`
- `GET /professional/specialties/:specialty/blockers`
- `DELETE /professional/specialties/:specialtyId`
- `PUT /professional/specialties/:specialtyId/credential`
- `POST /connections/invite-submissions`
- `GET /professional/students`
- `GET /professional/students/:studentUid/assignment-snapshot`
- `POST /training/workout-logs`
- `GET /training/workout-logs`
- `POST /nutrition/water-logs`
- `GET /nutrition/water-logs`
- `GET /nutrition/water-goal-context`
- `GET /nutrition/custom-meals`
- `GET /nutrition/custom-meals/:mealId`
- `POST /integrations/food/search`
- `POST /integrations/exercise/search`
- `GET /integrations/exercise/exercises/:exerciseId`
- `GET /plans/my`
- `GET /plans/predefined`
- `GET /plans/starter-templates`
- `POST /plans/starter-templates/:templateId/clone`
- `POST /plans/predefined/:planId/bulk-assign`
- `POST /plans/predefined/:planId/draft-assignments`
- `POST /plans/nutrition`
- `GET /plans/nutrition/:planId`
- `PATCH /plans/nutrition/:planId`
- `POST /plans/nutrition/:planId/meals`
- `PUT /plans/nutrition/:planId/meals/reorder`
- `DELETE /plans/nutrition/:planId/meals/:mealId`
- `POST /plans/nutrition/:planId/meals/:mealId/items`
- `PUT /plans/nutrition/:planId/meals/:mealId/items/reorder`
- `DELETE /plans/nutrition/:planId/meals/:mealId/items/:itemId`
- `DELETE /plans/nutrition/:planId`
- `POST /plans/training`
- `GET /plans/training/:planId`
- `PATCH /plans/training/:planId`
- `POST /plans/training/:planId/sessions`
- `PUT /plans/training/:planId/sessions/reorder`
- `DELETE /plans/training/:planId/sessions/:sessionId`
- `POST /plans/training/:planId/sessions/:sessionId/items`
- `PUT /plans/training/:planId/sessions/:sessionId/items/reorder`
- `DELETE /plans/training/:planId/sessions/:sessionId/items/:itemId`
- `DELETE /plans/training/:planId`
- `POST /plans/change-requests`
- `GET /professional/students/:studentUid/plan-change-requests`
- `PATCH /plans/change-requests/:requestId/review`

`DELETE /me` is the local account-deletion boundary used by mobile account settings. It removes direct account-owned local rows such as profile, support, password-reset artifacts, subscription snapshots, specialties, credentials, invite state, plans, logs, custom meals, and share artifacts. Relationship/history rows that may be needed by the other participant are ended and rewritten to a non-reversible `deleted_account_*` pseudonym so the deleted auth UID is not retained in local server tables.
- `POST /nutrition/meal-photo-analysis`
- `POST /nutrition/custom-meal-images/:mealId`
- `POST /nutrition/custom-meals`
- `PUT /nutrition/custom-meals/:mealId`
- `DELETE /nutrition/custom-meals/:mealId`
- `POST /nutrition/custom-meals/:mealId/share-links`
- `GET /nutrition/custom-meal-shares/:shareToken`
- `POST /nutrition/custom-meal-shares/:shareToken/import`
- `GET /media/custom-meal-images/:ownerAuthUid/:mealId/:filename`
- `GET /professional/students/:studentUid/tracking-review`
- `POST /nutrition/portion-logs`
- `GET /nutrition/portion-logs`
- `POST /support/messages`
- `POST /analytics/events`

`GET /health` returns server status plus `runtime.bunVersion`. The parent
`bun run local:doctor` command checks this field so stale local server
processes started with a non-pinned Bun runtime are caught.

`POST /auth/dev/session` is local-only scaffolding for development while remote auth is not set up. The server exposes this deterministic route only when `LOCAL_DEV_AUTH_ENABLED=false` is not configured, `NODE_ENV=production` is not set, and `APP_VARIANT` is unset, blank, or `dev`. Production and non-dev variants receive `404 local_dev_auth_disabled`, including from `POST /auth/dev/refresh`, before body validation, profile mutation, or token verification. When enabled, the route returns a JOSE RS256 bearer access token, sets the same token in an HTTP-only `mychampions_access_token` cookie for local clients that use cookie transport, returns server-owned `emailVerified:false`, and creates or updates the profile row without clearing locked role or accepted terms state. Protected routes accept the Elysia bearer plugin token first and fall back to the local access-token cookie when no bearer header is present.

Every refresh token contains a signed session id while only its SHA-256 digest is
stored in `auth_sessions`. `POST /auth/dev/refresh` consumes that row and writes
a replacement row atomically, so replaying an already-consumed refresh token
returns `401 invalid_refresh_token`. Refresh loads the current server-owned
profile before rotation, issues access and replacement-token identity claims from
that profile, and consumes the old session only after all fallible prerequisite
work succeeds. A transient profile or token-signing failure therefore leaves the
original refresh token retryable instead of stranding the client.

Server-owned Google and Apple identities are stored in `auth_identities` by the
provider and immutable provider subject, never by matching email. This prevents
implicit cross-provider account linking. A first social identity needs a verified
email; a returning Apple token may omit email only when its provider subject is
already stored. Account deletion removes the identity record with the account's
other direct data.

`POST /auth/email/sign-in` and `POST /auth/email/create-account` are the server-owned email/password auth boundary used by the mobile email auth source. They normalize email, verify or create Argon2id credentials in local Postgres, upsert the returned identity into `user_profiles`, then return the same JOSE bearer/refresh-token/cookie session shape as the local dev-session route. Local credentials return `emailVerified:false` because email verification is deferred and not required for MVP flows.

`POST /auth/social/sign-in` is the server-owned Google/Apple auth exchange boundary. Mobile continues native Google/Apple token capture and posts the captured token here before using deterministic local social sessions only for explicit provider-token configuration gaps in local development. The route accepts `provider`, provider `idToken`, and optional `accessToken`/`nonce`, verifies the token directly against the provider's JWKS, and requires the configured audience, issuer, subject, signature, and expiry. Google requires a verified email on every sign-in. Apple requires a verified email for first identity creation, while a returning signed Apple token without email is resolved only through its stored provider subject. Google audiences come from `GOOGLE_ANDROID_CLIENT_ID`, `GOOGLE_IOS_CLIENT_ID`, and `GOOGLE_WEB_CLIENT_ID`; Apple audiences come from `APPLE_CLIENT_ID` and `APPLE_WEB_CLIENT_ID`. The route returns `configuration` with HTTP 503 until the requested provider audience is configured.

`POST /auth/password-reset` accepts a normalized email address and records a provider-neutral local password-reset request in local Postgres table `password_reset_requests` through the server-owned password-reset service. The canonical request row stores only the SHA-256 token digest plus `expires_at`, and the HTTP response stays `{ "status": "accepted" }` without exposing provider, token, or delivery details. For local development, the server also writes a `password_reset_delivery_artifacts` debug-outbox row with the raw reset token and `mychampions://auth/password-reset?...` reset URL so the local flow can be inspected without remote email delivery. Direct transactional delivery stays disabled until its own transport credentials are configured.

`POST /support/messages` stores write-only support requests in local Postgres table `support_messages`. The mobile client sends subject/body plus app metadata; the server derives authenticated user metadata from the bearer token and stores new messages with `status='pending'`.

`POST /analytics/events` accepts unauthenticated provider-neutral mobile analytics events and stores them in local Postgres table `analytics_events`. The route is intentionally available before auth so auth-entry events can be captured, but it rejects any event properties containing sensitive keys such as email, tokens, passwords, invite codes, or secrets. The mobile analytics hook sends redacted best-effort events to this route when `EXPO_PUBLIC_MYCHAMPIONS_SERVER_URL` or Expo `extra.server.baseUrl` is configured.

Outside production, `POST /subscription/entitlements/snapshot` stores the authenticated user's latest RevenueCat-derived entitlement state in local Postgres table `subscription_entitlement_snapshots`. `GET /subscription/entitlements/snapshot` returns that authenticated user's latest local snapshot or `null` when none exists. The mobile subscription hook still presents native RevenueCat paywalls and reads store-backed customer info locally, then best-effort syncs `professionalEntitlementStatus`, `aiEntitlementStatus`, optional active-student count, professional entitlement expiry, renewal-risk state, and observation time to the MyChampions server for local development. The server validates expiry timestamps and keeps only strictly newer observations, so a delayed retry cannot roll a user back to an older entitlement state. Production rejects client snapshot writes with HTTP 403; cap and AI-access enforcement there must use the signed RevenueCat webhook snapshot. When native entitlement reads are unavailable during local development, the hook can hydrate from the server-owned local snapshot so local gates can continue without remote RevenueCat credentials.

`POST /webhooks/revenuecat` accepts RevenueCat server-to-server webhook events, identifies every affected MyChampions auth UID (including both sides of `TRANSFER` events), and reconciles each customer through the server-only RevenueCat subscriber API before writing `subscription_entitlement_snapshots`. Authenticated dashboard `TEST` events are acknowledged without customer reconciliation because RevenueCat's purchase-like test payload is synthetic and is not persisted by the provider. Multi-customer transfer snapshots persist in one database transaction, so source and destination privilege changes commit or roll back together. Canonical customer lookup has a 10-second deadline covering both connection and response-body reads. Provider observation timestamps are trusted only within 24 hours of server time; out-of-window values fall back to another valid provider timestamp or server time so a malformed future date cannot freeze newer reconciliation. The canonical reconciliation reads `professional_pro` and `student_pro` independently, derives professional expiry and renewal-risk metadata from authoritative entitlement data, and prevents a partial event for one product from revoking the unrelated privilege. A successful subscriber response must contain well-formed canonical entitlement and subscription collections; incomplete collections, malformed entries, invalid product identifiers, and invalid canonical timestamps are rejected instead of being persisted as lapsed access. Provider/configuration/response failures return a retryable non-2xx response instead of acknowledging an unsynchronized event. The endpoint is disabled until `REVENUECAT_WEBHOOK_AUTHORIZATION` exactly matches the Authorization header configured in the RevenueCat dashboard and `REVENUECAT_SECRET_API_KEY` contains a server-only `sk_*` key. In production, `REVENUECAT_WEBHOOK_SIGNING_SECRET` is also required; the route verifies RevenueCat's dashboard-enabled [`X-RevenueCat-Webhook-Signature` HMAC delivery](https://www.revenuecat.com/docs/integrations/webhooks#webhook-signature-verification-hmac) over the raw JSON body before parsing. No RevenueCat secret is exposed to the mobile app. Live setup still requires the dashboard webhook URL, authorization/HMAC values, App User ID alignment, and provider smoke verification.

After an approved live purchase, the following read-only verifier polls the
canonical RevenueCat customer and the matching production snapshot without
printing credentials or writing provider/database state:

```bash
REVENUECAT_TEST_APP_USER_ID=<unique-live-uid> \
EXPECTED_PROFESSIONAL_STATUS=active \
EXPECTED_AI_STATUS=lapsed \
bun run evidence:revenuecat-live -- --verify
```

The verifier defaults to a no-SSH dry run when `--verify` is omitted, refuses
hosts other than `digiocean`, requires exactly one running server slot, and
refreshes both canonical provider privileges and the server snapshot inside
the bounded timeout loop. It succeeds only when both reads match the expected
independent privileges in the same iteration.

`GET /connections` lists the authenticated user's student-side and professional-side connections from local Postgres table `connections`. The mobile client uses this endpoint for `getMyConnections()` when a local server bearer token is available.

`POST /connections/invite-submissions` accepts a student invite code, looks up an active local Postgres `invite_codes` row, blocks duplicate active/pending student-professional-specialty connections, enforces the 10-unique-pending-students cap, and creates a `pending_confirmation` row in `connections`. The mobile `submitInviteCode()` source requires this endpoint plus local server bearer auth; missing local server URL/auth fails closed without calling any provider-era function path.

`GET /professional/invite-codes/:specialty` and `POST /professional/invite-codes/:specialty/rotate` manage active Specialty-scoped invite codes in local Postgres. Rotation changes the code value and ends pending requests created from the old code.

`GET /professional/specialties` returns the authenticated professional's local Postgres `professional_specialties` rows joined with `professional_credentials`. `POST /professional/specialties` creates or reactivates the requested specialty for the authenticated professional. `GET /professional/specialties/:specialty/blockers` counts active and pending local Postgres `connections` for the authenticated professional and Specialty. `DELETE /professional/specialties/:specialtyId` deactivates an owned removable Specialty and revokes its active invite code; it rejects the last active Specialty and active/pending blockers. `PUT /professional/specialties/:specialtyId/credential` upserts the owned Specialty's `professional_registry` credential. The mobile `professional-source` requires these endpoints plus local server bearer auth outside explicit E2E fixtures; missing local server URL/auth fails closed.

`POST /connections/:connectionId/confirm` activates an owned pending connection for the authenticated professional, releases its local pending invite guard/student-slot state, writes active `tracking_access` and `active_specialties` rows, and archives active self-managed nutrition or training plans for that connection's specialty. `POST /connections/:connectionId/end` marks a connection ended for either authenticated participant, releases any local pending invite guard/student-slot state, writes ended `tracking_access`, updates `active_specialties` only when the ending connection owns the sentinel, archives active assigned plans from that professional for the matching specialty, and restores the latest self-managed plan previously archived by that connection. Invite-code rotation also ends pending requests created from the old code and releases their local pending invite state.

`GET /professional/students` groups the authenticated professional's active and pending local Postgres `connections` rows by student, enriches display names from `user_profiles`, and returns assignment status summaries for roster cards. `GET /professional/students/:studentUid/assignment-snapshot` returns the selected student's nutrition/training assignment status and active connection IDs for the professional profile view; it requires the authenticated professional to have at least one connection record (active, pending, or ended) with the requested student and returns `403 assignment_snapshot_forbidden` otherwise. The mobile `professional-source` requires these endpoints plus local server bearer auth outside explicit E2E fixtures; missing local server URL/auth fails closed.

`POST /training/workout-logs` creates a student-owned workout completion log in local Postgres table `workout_logs`. `GET /training/workout-logs?from=<iso>` returns the authenticated student's workout logs since the requested timestamp. The mobile `workout-log-source` requires these endpoints plus local server bearer auth outside the assigned-training E2E fixture; missing local server URL/auth fails closed.

`POST /nutrition/water-logs` increments or creates the authenticated student's daily water-intake log in local Postgres table `water_logs`. `GET /nutrition/water-logs` returns the authenticated student's water logs newest date first. `GET /nutrition/water-goal-context` reads local Postgres `nutrition_plans` and active nutritionist `connections` to resolve the student's personal hydration goal, assigned nutritionist goal, and active-assignment flag. The mobile `water-tracking-source` requires these endpoints plus local server bearer auth outside nutrition E2E fixtures; missing local server URL/auth fails closed.

`GET /professional/students/:studentUid/tracking-review?todayKey=<yyyy-mm-dd>` returns `waterGoalMl` alongside the connected student's seven-day water logs and recent portion logs for read-only professional review. The route requires an active nutritionist connection owned by the authenticated professional before it reads tracking repositories, then the server resolves the effective hydration goal from local water-goal context instead of trusting a mobile-supplied goal value. The mobile `student-tracking-review-source` requires this endpoint plus local server bearer auth outside explicit E2E fixtures; missing local server URL/auth fails closed.

`GET /nutrition/custom-meals`, `GET /nutrition/custom-meals/:mealId`, `POST /nutrition/custom-meals`, `PUT /nutrition/custom-meals/:mealId`, and `DELETE /nutrition/custom-meals/:mealId` manage authenticated-owner custom meal definitions in local Postgres table `custom_meals`. `POST /nutrition/custom-meals/:mealId/share-links` stores immutable nutrition snapshots in `meal_share_links`, `GET /nutrition/custom-meal-shares/:shareToken` previews a shared meal without bearer auth, and `POST /nutrition/custom-meal-shares/:shareToken/import` creates or reuses one recipient-owned imported copy. `POST /nutrition/custom-meal-images/:mealId` stores authenticated-owner JPEG meal images in local filesystem storage under `.local-storage/meal-images` by default; when `GCS_BUCKET` is configured, the same route writes to private GCS objects and returns the server media URL. `GET /media/custom-meal-images/:ownerAuthUid/:mealId/:filename` requires a bearer token whose `auth.sub` matches the `:ownerAuthUid` path segment (401 with no/invalid token, 403 for a token belonging to a different owner) before serving the image back through the configured storage adapter. The mobile `custom-meal-source` requires the meal definition/share endpoints for library reads, create/update/delete, share link creation, shared recipe preview/import, and quick-log meal snapshot reads outside E2E fixtures; missing local server URL/auth fails closed. The mobile image upload hook requires this local server upload path and fails closed when local server URL/auth is unavailable.

`POST /integrations/food/search` searches the local mirrored food catalog Postgres database through `FOOD_CATALOG_DATABASE_URL`. The route requires a MyChampions server bearer token and returns the same food macro result shape consumed by the existing mobile food-search source. The mobile `food-search-source` now requires the MyChampions server URL plus local bearer token and fails closed when that local auth path is unavailable. When the catalog query itself fails (missing table, connection error, etc.), the route responds `502 {"error":"upstream","message":"Food catalog search failed."}`; the raw driver error is logged server-side only, never returned to the client.

`POST /integrations/exercise/search` and `GET /integrations/exercise/exercises/:exerciseId` search and read the local mirrored exercise catalog Postgres database through `EXERCISE_CATALOG_DATABASE_URL`. The routes require a MyChampions server bearer token and return the exercise catalog shape consumed by the existing mobile exercise source. The mobile `exercise-service-source` now requires the MyChampions server URL plus local bearer token and fails closed when that local auth path is unavailable. When the catalog query itself fails (missing table, connection error, etc.), the routes respond `502 {"error":"upstream","message":"Exercise catalog search failed."}`; the raw driver error is logged server-side only, never returned to the client.

`POST /plans/change-requests` stores authenticated student plan-change requests in local Postgres table `plan_change_requests`. `GET /professional/students/:studentUid/plan-change-requests` lists requests for the selected student, and `PATCH /plans/change-requests/:requestId/review` marks a request as `reviewed` or `dismissed`. The mobile `plan-source` requires these endpoints plus local server bearer auth outside E2E fixtures; missing local server URL/auth fails closed.

`GET /plans/my` lists the authenticated user's visible local Postgres nutrition/training plans from `nutrition_plans` and `training_plans`, filtering archived rows and hiding assigned nutrition drafts from students until the professional publishes them. `GET /plans/predefined` lists predefined nutrition/training plans owned by the authenticated professional newest first. `GET /plans/starter-templates?planType=nutrition|training` returns the server-owned starter template catalog used by the mobile plan builder. `POST /plans/starter-templates/:templateId/clone` creates a professional-library nutrition or training plan from the server-owned template defaults, including starter meals/sessions and their items. `POST /plans/predefined/:planId/bulk-assign` clones a professional-owned predefined nutrition or training plan into assigned non-draft plans for students with an active matching-specialty connection. `POST /plans/predefined/:planId/draft-assignments` clones one professional-owned predefined nutrition or training plan into an assigned draft for a student with an active matching-specialty connection. The mobile `plan-source` requires these endpoints for `getMyPlans()`, `getMyPredefinedPlans()`, `bulkAssignPredefinedPlan()`, and `createDraftAssignedPlan()` outside E2E fixtures; missing local server URL/auth fails closed.

`POST /plans/nutrition` and `POST /plans/training` create authenticated-user plan-builder rows as either professional-library predefined plans or self-managed student plans. `GET /plans/nutrition/:planId` and `GET /plans/training/:planId` return full plan-builder detail from local Postgres, including nutrition `meals` and training `sessions` JSON payloads. `PATCH /plans/nutrition/:planId` updates plan metadata, hydration goal, and optional publish state; `PATCH /plans/training/:planId` updates metadata, optional full session payload, and optional publish state. Nutrition meal/item routes and training session/item routes mutate the stored JSON payloads directly. `DELETE /plans/nutrition/:planId` and `DELETE /plans/training/:planId` archive authorized plans instead of hard-deleting rows. Owner professionals can edit/delete owned assigned/predefined plans, and students can edit/delete only self-managed plans. The mobile `plan-builder-source` requires these endpoints for plan create/delete, detail reads, metadata updates, full training session saves, and item-level builder mutations outside E2E fixtures; missing local server URL/auth fails closed.

`POST /nutrition/meal-photo-analysis` accepts authenticated base64 JPEG meal photos and delegates macro estimation to the configured server-side meal-photo analyzer. The local server trims image input, rejects blank or whitespace-only images with `400 invalid_image`, rejects images above 6,000,000 base64 characters with `413 file_too_large` before analyzer execution, returns the advisory macro-estimate contract consumed by mobile, and reports `configuration` when no analyzer provider is configured. The server-owned analyzer request contract pins image detail to `high`, caps provider output at 500 tokens, and builds the JPEG data URL from the normalized base64 payload before any future provider adapter call. `MEAL_PHOTO_ANALYZER=local_mock` enables a deterministic low-confidence local mock for development and integration testing without remote provider credentials. The mobile `meal-photo-analysis-source` now requires this endpoint plus a local server bearer token; missing local auth fails closed.

`POST /nutrition/portion-logs` stores the authenticated student's consumed portion log in local Postgres table `portion_logs`, including the nutrition snapshot and optional assigned-plan provenance. `GET /nutrition/portion-logs?from=<iso>` returns the authenticated student's portion logs since the requested timestamp. The mobile `custom-meal-source` uses these endpoints for assigned meal portion logs, custom-meal quick logs, and today's portion-log reads when a local server bearer token is available.

The mobile app posts email/password sign-in and create-account attempts to the MyChampions server email auth boundary. Those attempts use local Postgres credentials by default; Google and Apple identity tokens are verified directly when their server audiences are configured. The deterministic local dev-session bridge remains available only when `LOCAL_DEV_AUTH_ENABLED=false` is not configured, `NODE_ENV=production` is not set, and `APP_VARIANT` is unset, blank, or `dev`.
