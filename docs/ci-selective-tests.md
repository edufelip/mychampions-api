# Selective test execution in CI

`.github/workflows/ci.yml` narrows the `test` job to only the tests related to
what a PR actually changed, instead of always running the full `bun test`
suite. This is a strict narrowing — it never widens coverage beyond what the
full suite already runs, and it always falls back to the full suite when it
can't be sure a narrower run is safe.

## How it works

1. The `impact` job computes `git merge-base <base> <head>` explicitly, then
   diffs merge-base to head with `git diff --name-status -z -M`. Using the
   merge-base (not the base branch tip) means commits that land on `main`
   after a PR branched off are never misattributed to that PR's diff.
2. `scripts/ci/classify-change-scope.ts` classifies every changed path into
   one of: a full-scope trigger, a known-inert path (docs, markdown), a
   normal source/test path, or unrecognized. Any full-scope trigger or any
   unrecognized path sets `full_scope=true`.
3. If `full_scope` is true, `test` runs `bun test` (everything). Otherwise it
   runs `bun test --changed=<merge-base> --pass-with-no-tests`, which lets
   Bun's own dependency graph pick the related test files. `--pass-with-no-tests`
   means a docs-only change that touches zero tests doesn't fail the job.
4. `typecheck` and `docker-build` are unaffected by this — they're cheap
   enough to always run in full regardless of scope.
5. Any push to `main` (a merge or a direct push) always runs the full suite;
   only pull requests get narrowed. That's the authoritative build, not a
   candidate to trust a partial run for.

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
# tests only.
bun scripts/ci/classify-change-scope.ts <base-sha> <head-sha>
bun test --changed=<merge-base-sha> --pass-with-no-tests

# Simulate a docs-only PR — narrow, zero tests, exits 0.
# Simulate a package.json/bun.lock/tsconfig change — full scope.
```

`tests/ci-classify-change-scope.test.ts` covers the classifier's decision
logic directly (dependency/tooling/workflow/classifier changes → full scope;
src/tests/docs-only changes → narrow; unrecognized paths → full scope).
