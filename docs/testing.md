# Owned test databases

`bun run test:unit` enumerates non-Postgres test files (`bun --no-env-file scripts/testing/run.ts unit --changed=<commit-sha>` narrows them to files related to changes since that commit). `bun run test:integration` owns a unique loopback-only Docker Compose Postgres instance, primary/food/exercise databases, private credentials, canonical server migrations, synthetic catalog seeds, serial test execution, and a receipt under ignored `.qa/runtime/<run-id>/`.

Every Postgres test, including direct `bun test tests/postgres-*.test.ts`, requires an explicit URL, local allocated port, exact database/run manifest, owner token proof and a matching in-database marker before test mutations. Defaults and developer port 15432 are forbidden. Plain `bun test` runs non-DB tests but reports DB files as explicit errors if no owned run exists. Use the separate commands for a green intended scope.

The bootstrap may create markers/databases only inside a fresh label-verified owned container. Migrations and seeds recheck ownership. Catalog schemas come from pinned copies of the food and exercise service schemas in `scripts/testing/catalog-schemas/` (see [Catalog schema copies](#catalog-schema-copies)); when a sibling checkout exists, the runner refuses to start unless the copy matches it. No public seed/reset endpoint is introduced. `scripts/testing/fixtures.ts` supplies attempt-scoped new/unonboarded, student, fitness coach, unrelated student/coach, pending and active connection accounts, a saved training template and a local-only draft payload. It uses existing typed repositories/gateway for declared preconditions; actions under test use the public API. Account passwords derive from the private owner token and scope, so partial seed retries are stable. A new scope is required after tested actions change fixture state. Credentials live in private fixture JSON and are removed on successful cleanup.

`tests/postgres-api-journeys.test.ts` starts the real app with Postgres repositories, loopback ephemeral HTTP, and run-owned signing/image storage. It verifies create/update, durable reads after process restart, assigned-copy independence, pending/active public connection transitions, unrelated/read-only access denial and unchanged data, validation rejection/retry, refresh rotation and logout revocation. Local email auth is exercised; Apple/Google/RevenueCat are not. Unrelated plan access is hidden as 404; the connected student's forbidden edit returns 403; sign-out returns 204. A 422 validation retry is distinct from the transport/save fault injection still required in later phases.

Test children use `--no-env-file` and a minimal explicit environment. Startup blocks are recorded as harness blocks, not application failures. `scripts/testing/verify-lifecycle.ts` verifies simultaneous isolation, seed equivalence, test-execution SIGINT/SIGTERM and API-child cancellation. API process ledgers bind PID, start time, script, run and attempt; foreign/reused PIDs are never signalled. Cleanup-failure guard tests retain records before any Docker mutation.

The private `compose.env` and `private.json` have mode 0600; reports contain identities, counts and result classifications, not credentials. Failure/SIGINT/SIGTERM run cleanup. Cleanup verifies the exact owned container and retains its ledger on failure; explicit recovery uses `MC_TEST_MANIFEST=<absolute owned manifest> bun scripts/testing/cleanup.ts`. It never deletes shared databases or kills arbitrary listeners.

The owned runner itself does not modify production VM compose or provider configuration. The separately restored password-reset confirmation route adds canonical migration 0025 (`consumed_at`) and the atomic server-auth behavior documented in README; its local test evidence does not establish production deployment. Local integration receipts do not establish hosted CI, native, provider or store acceptance. See the client BL-018 plan/task card for remaining phases.

## Hosted CI and server-only runs

`.github/workflows/ci.yml` runs every `tests/postgres-*` file on every pull
request and push with `bun run test:integration:server-only`. It is the owned
runner above with one difference: the client checkout (`../mychampions`) may be
absent, because hosted server CI checks out only this repository. An absent
client is recorded in the manifest as git's null object ID and an all-zero
working-tree hash, which no real checkout produces, and the receipt states
`"scope": "server-only"` and `"clientCheckout": "absent"`. A client directory
that exists but cannot be fingerprinted still fails the preflight. Without
`--server-only`, a missing client still fails before any runtime directory or
Docker resource exists. The guard, Compose isolation,
migrations, seeds, file selection and cleanup are unchanged; CI does not use a
GitHub Actions Postgres service. See
[ci-selective-tests.md](ci-selective-tests.md#database-in-ci).

## Catalog schema copies

The server reads the food and exercise catalog tables but does not own their
schemas. `scripts/testing/catalog-schemas/` holds pinned copies of
`FOOD_CATALOG_SCHEMA_SQL` (`mychampionsapi-food`) and
`EXERCISE_CATALOG_SCHEMA_SQL` (`mychampionsapi-exercises`), with the source
repository, file, last source commit and SHA-256 in `provenance.json`. Seeding
always uses the copies, so local and CI catalog databases get the same schema.
Before acquiring anything, the runner checks each copy against its digest and,
when the sibling checkout exists, against that checkout's exported schema; a
mismatch blocks the run. After a catalog schema change is committed in its
service:

1. Check out the intended service commit in the sibling directory.
2. Run `bun --no-env-file scripts/testing/catalog-schemas.ts --sync` from
   `server/` (it refuses an uncommitted schema module).
3. Run `bun --no-env-file scripts/testing/catalog-schemas.ts --check`.
4. Commit the updated `scripts/testing/catalog-schemas/` files.

The catalog gateway tests now always run against the three synthetic rows per
catalog, locally and in CI.

## Owned session auth rate limit

The credential-adjacent auth routes share a per-IP budget
(`AUTH_RATE_LIMIT_MAX`, default 20 per `AUTH_RATE_LIMIT_WINDOW_MS` = 60 s).
Browser and native journeys sign in many times through one loopback IP, so
owned sessions started by `scripts/testing/session.ts` give their API child
`AUTH_RATE_LIMIT_MAX=1000` (`OWNED_SESSION_AUTH_RATE_LIMIT_MAX` in
`owned-runtime.ts`); the window stays 60 s. Only the owned session environment
carries this value. The integration runner keeps the production default, so
`tests/postgres-*` still run against the default budget, and production
configuration (`.env.example`, Railway, Nginx) is unchanged.
`tests/owned-test-environment.test.ts` checks both budgets through the real
app, and `verify-runtime-handoff.ts` signs in 25 times through one owned
session.

## Shared acquisition and private runner sessions (P3/T10)

`scripts/testing/owned-runtime.ts` now owns the same bootstrap used by `run.ts`:
fresh Compose/database identity, canonical migrations, catalog seeds, explicit
private environment, owner guards and cleanup. `createOwnedTestRuntime()` creates
the ledger; callers must put `await runtime.start()` inside `try/finally` with
`await runtime.release()`. Start is single-use; repeated release calls share the
same promise. The module does not change the process working directory or install
signal handlers. Callers forward signals through `runtime.cancel(signal)` and
register an owned executing test child through `await runtime.trackChild(child)`.
The existing unit/integration commands, serial selection and receipt/exit behavior
remain intact. Cleanup resolves the server Compose path independently of caller
cwd and retains records on ownership or cleanup errors.

`session.ts` is a pinned-Bun, private parent/child stdio bridge for later browser
and native runners. It is not an HTTP administration endpoint. Launch with
`../scripts/server-bun.sh --no-env-file scripts/testing/session.ts`; optional
`--web-origin http://127.0.0.1:<allocated-app-port>` may repeat. Origins must be
exact loopback HTTP origins without paths or credentials. `--deadline-ms` accepts
1000–3600000 (default 600000). API children get only the owned environment,
including exact allowed browser origins, local signing/image storage and all three
DB URLs. Developer DB URLs and provider credentials inherited by the parent do
not enter that environment. Migration/catalog notices go to stderr; stdout contains
one JSON protocol message per line.

The bridge emits `acquired` after a private ownership manifest is persisted and
signal handlers are installed, before DB/API readiness. This event proves a
resource ledger, not a healthy backend. A bootstrap manifest may have port 0.
`ready` requires real DB/API health and a bound port. Clients validate both
events' canonical root, PID/start/script and pinned owner digest. An early
`closed` must bind its final private manifest/receipt to the acquired identity;
an absent or mismatched close never establishes successful cleanup.
Abort signals during acquisition are forwarded to the owned session, which
attempts cleanup before returning a nonzero result. Wrapper receipts preserve
the acquisition child status and distinguish cleaned, not acquired and unknown
recovery. Explicit acquisition and bootstrap recovery verifiers establish the
locally verified BL-018/T10 scope recorded in the client task card.

Compose containers and the default network carry run ID and owner-digest labels.
Cancellation between creation and container-ID persistence may recover only
exact resources whose project, service/network, run and owner labels match.
Unknown resources remain untouched with recovery ledgers; project prefix alone
cannot authorize deletion. Cleanup inspects containers and networks separately,
including a network created before any container, and verifies both are gone.

The bridge emits `ready` after real DB/API health. Requests have a unique `id`:
`{ "id": "seed-1", "op": "seed", "scope": "auth-1" }` returns a restricted
fixture file reference; `{ "id": "restart-1", "op": "restart", "attempt":
"durability-1" }` replaces the API process while retaining the owned DB/key;
`{ "id": "stop-1", "op": "stop" }` closes after cleanup. Scope and API attempt
IDs cannot be reused in a session. Unknown fields/operations and duplicate request
IDs block rather than reset tested data. The caller reads credentials only from
the private fixture file and never copies them into public reports.

`{ "id": "snapshot-1", "op": "snapshot", "scope": "auth-1" }` returns
a protected read-only domain snapshot for a seeded scope, as detailed below.

`{ "id": "connection-snapshot-1", "op": "connection-snapshot", "scope": "connection-1" }`
returns a separate protected `connection-snapshot-v1` artifact at
`connection-snapshot-<scope>-<request-id>.private.json`. The request has no
phase or SQL/table selector: it always reads the complete connection projection
for every fixture account in the scope and emits a `connection-snapshotted`
event. The projection contains `userProfiles`, `professionalSpecialties`,
`inviteCodes`, `connections`, `connectionInviteGuards`, `pendingStudents`,
`pendingStudentSlots`, `trackingAccess` and `activeSpecialties`, with deterministic
primary-key ordering and a 200-row limit per table; the 201st row fails the
snapshot. Relationship tables include rows whose professional or student
endpoint is a fixture account, plus auxiliary rows referenced by selected
connection or pending-slot IDs, so a foreign endpoint cannot hide a selected
edge. Professional-specialty and invite-code tables remain bounded to fixture
professional owners. The snapshot is read-only, uses the owned database guard
and repeatable-read transaction, uses explicit `COLLATE "C"` primary-key
ordering, and is written exclusively with mode 0600.
Raw invite values, account credentials and the auth-credential table are never
projected. A released pending slot remains present with a null student owner.
This operation only observes state; submit and confirm remain public API/UI
actions, and the existing `domain-snapshot-v1` contract is unchanged.

Normal stop returns 0; invalid protocol, deadline or parent EOF returns 2;
SIGINT/SIGTERM preserve 130/143. API shutdown and database release are both attempted
even if one fails. `closed` points to an internal `session-receipt.json` containing
control operations and cleanup results; it is not yet the full cross-layer public
receipt schema from the client plan. The client now validates that full schema
separately; integrated attempt producers now execute locally. Its Node bridge validates
these private control documents and ownership before consumption. Docker command
deadlines are 120s, API readiness 15s
with bounded health probes, API stop 10s before signalling the owned child with
SIGKILL, container inspection 15s and Compose cleanup 60s.

Explicit local verification uses pinned Bun with
`--no-env-file scripts/testing/verify-runtime-handoff.ts`. It checks direct
single-start/idempotent release, two sessions launched from the client cwd,
separate DB/API ports and fixture owners, identical catalog hashes, excluded
provider credentials, real email sign-in/write/read after API restart, normal
stop, SIGINT/SIGTERM, parent disconnect, duplicate requests and session timeout.
Receipts also check observed API PIDs and owned Docker resources are gone. The
server sign-in endpoint's existing success status is 201. These are backend
handoff tests. Separately, the client auth journey executes across nine browser
cells; four other integrated journeys remain pending.

## Schema validation and client handoff

Eight canonical Draft 7 schemas live in `scripts/testing/schemas/`. AJV 8.18.0
validates generated/consumed manifests, API records, fixtures and private session
protocol/receipts. Resource manifests include canonical roots, fixture scopes
and PID/start/script records; a foreign or stale identity cannot authorize SQL,
cleanup or API handoff. Fixture plan IDs follow the existing
`training_plan_<UUID>` model. Errors expose schema paths/keywords, not field data.

The client vendors these files with content-hash provenance; its sync `--check`
command rejects drift. `scripts/testing/owned-session.ts` validates all protocol
messages and private files (canonical path, ownership, mode 0600 under mode 0700,
no symlink), matches API process ledgers and checks health. Its explicit local
Docker verifier covers concurrent clients, restart durability, both signals,
duplicate scopes and cleanup. Unit/type checks do not acquire Docker resources.

Runtime release stops a live owned tracked test child before database deletion.
Bun signal termination is established by awaiting `exited` and checking
`signalCode`; `exitCode` alone remains null for a signal. Cleanup retains ledgers
on identity failure. These checks remain backend handoff evidence. Client public
attempt producers and the auth matrix are locally exercised; four other browser
journeys and hosted/native gates remain pending.

`verify-bootstrap-recovery.ts` checks a created container whose ID was not yet
persisted, an owned network before container creation, and a wrong-owner network
negative control. Real cleanup preserves the negative control; its creator removes
only its separately verified resource before retrying owned cleanup. The client
`verify-session-acquisition.ts` checks preflight no-acquisition, cancellation after
the ledger, a startup deadline and normal readiness/stop. These are explicit
local Docker verifiers, not ordinary unit tests or native acceptance.

## Process-query integrity

Startup and cleanup read process start time, command and status with bounded
asynchronous `ps` queries. A successful query with empty output is unknown, not
proof of absence. Only exit 1 with empty stdout/stderr establishes no matching
PID. Command errors, deadlines and ambiguous output fail closed and retain the
resource ledger; they cannot authorize a signal or a cleaned receipt. Startup
requires a nonempty start identity before publishing an API process ledger.
This hardening follows a retained empty-start query failure; its root cause is
not established and a passing repeat does not erase its first attempt.

## Private domain snapshots (T11 preparation)

The stdio session accepts `{ id, op: "snapshot", scope }` only for a previously
seeded scope. It returns a protected private snapshot file reference. Fixed SELECT
queries read training plans belonging to that scope's fixture accounts and
connections between those accounts, inside a read-only repeatable-read transaction
on the guard-verified owned primary DB. Snapshots include complete domain rows,
including timestamps and connection provenance, for before/after comparisons.
These synthetic values stay private. No query, URL, UID or table name is
accepted from the caller. Read-only mode is observed in the result. More than
200 rows per table blocks instead of truncating results. Identity/schema checks
precede consumption; successful cleanup removes these private snapshot files.
Snapshots prove observed DB state only. They cannot perform the UI action or
replace the browser journey, authenticated API read, restart or retry assertions.
Worker controls and four integrated UI journeys remain pending.

## Retained process identities after restart and release

The resource manifest's `processes` is an acquisition history, not a live-process
list. Persist retains validated API and test-child identities after their live
records are removed, so terminal independent audits can check every PID/start
pair from before and after a restart. Repeated identical records are deduplicated;
the same PID with a changed start, script or role blocks persistence and retains
recovery rather than overwriting the old identity. Existing schema/version and
unique-PID constraints remain unchanged. A retained identity does not authorize a
signal: release still checks the existing live API records and process queries.
An independent census must prove absence; terminal phase or history alone cannot
prove cleanup. This change affects only owned disposable test infrastructure.

## Repository fingerprint preflight

Before creating any runtime directory or private ownership ledger, `createOwnedTestRuntime` validates and fingerprints the server and client worktrees. Every non-excluded untracked path must be a regular file; directory and file symlinks produce an explicit preflight error instead of being read through. Existing regular-file hash inputs and exclusions remain unchanged. This protects test acquisition from scratch dependency-directory symlinks. Failed fingerprint validation creates no runtime namespace, Compose resource, API, or database.

A failed startup without an acquired manifest or matching `closed` receipt still does not prove cleanup. The client must retain unknown recovery evidence and use an independent audit; this preflight change does not implement the proposed startup-identity protocol. Production auth, persistence, storage and provider behavior are unchanged.

## Password-reset confirmation atomicity

`tests/postgres-password-reset-confirm.test.ts` exercises the public confirmation route, Argon2id replacement, old-password/refresh-token rejection, token replay, same-account versus foreign-session boundaries, missing-account rollback with the generic invalid-token response, injected failure after token CAS and before commit, and concurrent confirmation through the service and over HTTP (one reset, one invalid token). All token/password/session mutations share one transaction; a read-only token check and then password hashing precede it, so an invalid token never costs an Argon2id hash (`tests/password-reset.test.ts` covers that order without a database). Raw postgres.js fixture timestamps use ISO strings while production Drizzle timestamps remain Date values. Fresh owned run `f05cdb18475d8c49081c05db` passed 22/22 files and 86/86 tests; root independently verified cleanup and source preservation in its private qualification packet. Migration deployment and provider/native proof are separate pending gates.
