# Selective test execution in CI

`.github/workflows/ci.yml` runs on `pull_request` (and on pushes to `main`), so
every pull request runs the workflow YAML from its own branch. A change to this
workflow takes effect on the pull request that makes it.

The `Test` job has two parts:

- **Unit tests** (every `tests/*.test.ts` except `tests/postgres-*`). Pull
  requests narrow these to the files related to what the PR changed. This is a
  strict narrowing: it never widens coverage beyond the full unit suite, and it
  falls back to the full suite whenever it can't be sure a narrower run is safe.
- **Integration tests** (every `tests/postgres-*.test.ts`). These always run in
  full, on every pull request and every push, through the owned disposable
  Postgres runner. See [Database in CI](#database-in-ci).

## How it works

1. The `impact` job computes `git merge-base <base> <head>` explicitly, then
   diffs merge-base to head with `git diff --name-status -z -M`. Using the
   merge-base (not the base branch tip) means commits that land on `main`
   after a PR branched off are never misattributed to that PR's diff.
2. `scripts/ci/classify-change-scope.ts` classifies every changed path into
   one of: a full-scope trigger, a known-inert path (docs, markdown), a
   normal source/test path, or unrecognized. Any full-scope trigger or any
   unrecognized path sets `full_scope=true`.
3. If `full_scope` is true, the unit step runs `bun run test:unit` (every unit
   file). Otherwise it runs
   `bun --no-env-file scripts/testing/run.ts unit --changed=<merge-base>`, which
   passes the explicit unit file list to `bun test --changed=<merge-base>
   --pass-with-no-tests`, so Bun's own dependency graph picks the related unit
   files and never a `tests/postgres-*` file. `--pass-with-no-tests` means a
   docs-only change that touches zero unit tests doesn't fail the step. The
   runner accepts only a hex commit ID after `--changed=`.
4. The integration step is not narrowed. It runs all `tests/postgres-*` files
   (about 20 s of tests locally) whatever the scope, because the harness it
   depends on includes paths the classifier treats as inert, such as
   `infra/docker-compose.test.yml`.
5. `typecheck` and `docker-build` are unaffected by this — they're cheap
   enough to always run in full regardless of scope.
6. Any push to `main` (a merge or a direct push) always runs the full unit
   suite; only pull requests get narrowed. That's the authoritative build, not
   a candidate to trust a partial run for.

## What forces full scope

- Dependency/lockfile changes: `package.json`, `bun.lock`, `.bun-version`
- Build/tooling config: `tsconfig.json`, `Dockerfile`, `drizzle.config.ts`,
  anything under `drizzle/` (schema-of-record changes are cross-cutting)
- The CI workflow files themselves (`.github/workflows/**`)
- The classifier script itself (`scripts/ci/**`)
- Any path that isn't recognized as one of the above, `src/**`, `tests/**`,
  or a known-inert path (`README.md`, `docs/**`, `*.md`, `.gitignore`,
  `.env.example`, `infra/**`) — fail conservative, not silent.

## Verifying locally

```bash
# Simulate a PR whose only change is under src/ or tests/ — narrow, related
# unit tests only.
bun scripts/ci/classify-change-scope.ts <base-sha> <head-sha>
bun --no-env-file scripts/testing/run.ts unit --changed=<merge-base-sha>

# Simulate a docs-only PR — narrow, zero tests, exits 0.
# Simulate a package.json/bun.lock/tsconfig change — full scope.
```

`tests/ci-classify-change-scope.test.ts` covers the classifier's decision
logic directly (dependency/tooling/workflow/classifier changes → full scope;
src/tests/docs-only changes → narrow; unrecognized paths → full scope).

## Database in CI

The integration step runs `bun run test:integration:server-only`. That is the
same owned runner developers use (`bun run test:integration`, see
[testing.md](testing.md)), with the same test database guard:

1. A fresh Docker Compose Postgres (`infra/docker-compose.test.yml`) with run
   and owner-digest labels, published on a random `127.0.0.1` port with tmpfs
   storage. The runner checks the container's labels before using it.
2. A private manifest under `.qa/runtime/<run-id>/`, an owner token, and an
   in-database ownership marker in each of the three databases
   (`mc_test_<run-id>`, `_food`, `_exercise`).
3. Canonical server migrations from `drizzle/`, then three synthetic rows per
   catalog (`scripts/testing/seed.ts`).
4. Every `tests/postgres-*` file, one at a time, with a minimal explicit
   environment. Tests refuse any database that lacks the manifest, owner token
   and marker.
5. Cleanup of the exact owned container and network, then a receipt.

Hosted CI checks out only this repository (no client or catalog service
checkout, and no cross-repository token), so two things differ from a local
run, and nothing else does:

- `--server-only` lets the client checkout (`../mychampions`) be absent. The
  manifest schema still needs a client identity, so the run records git's null
  object ID (`0` × 40) and an all-zero working-tree hash for it. No real
  checkout has those values, so anything that compares this identity with a
  real client fails closed. The receipt says `"scope": "server-only"` and
  `"clientCheckout": "absent"`. Browser and native sessions
  (`scripts/testing/session.ts`) always require the real client checkout.
- The catalog schemas come from the pinned copies in
  `scripts/testing/catalog-schemas/` (food and exercise service schemas, with
  source commit and SHA-256 in `provenance.json`). Locally, when
  `../mychampionsapi-food` or `../mychampionsapi-exercises` exists, the runner
  refuses to start unless the copy equals that checkout's exported schema.
  Refresh the copies with `bun --no-env-file scripts/testing/catalog-schemas.ts --sync`
  and check them with `--check` (see [testing.md](testing.md#catalog-schema-copies)).

Because every owned run seeds the catalogs, the catalog gateway cases in
`tests/postgres-{exercise,food}-search-gateway.test.ts` run in CI too; they no
longer skip themselves when `CI=true`.

The job pulls the Postgres image in its own step first, so a registry problem
is not reported as a harness failure. After the integration step, the job
prints the receipt (identities, counts and result classes, no credentials) and
runs an independent census: it fails if any container or network labelled with
one of the job's run IDs (`com.mychampions.test.run=<run-id>`, one per
`.qa/runtime/<run-id>/` directory) remains.

The job no longer runs a GitHub Actions Postgres service. Plain `bun test`
against such a database fails every `tests/postgres-*` file with
`Missing MC_TEST_MANIFEST`, by design: the guard does not accept a database it
did not create, however it was provisioned.
