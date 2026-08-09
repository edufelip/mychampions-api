# Server service quality gates

The root MyChampions server is the active auth/session, Postgres/Drizzle,
image-storage, and provider-reconciliation authority. The service gate keeps
its Bun-native test suite and adds explicit static-analysis, compile, and
contract commands.

## Required commands

- `bun run lint` scans `src`, `tests`, and `drizzle.config.ts` with ESLint.
- `bun run build` runs the strict TypeScript compiler without emitting files.
- `bun run test:integration` runs the Bun test suite, including HTTP boundary
  tests backed by in-memory repositories and provider doubles.
- `bun run test:contract` runs the stack/deployment and provider-boundary
  contract tests.

The hosted `Service Quality` workflow checks out the exact pull-request head,
provisions isolated Postgres databases, applies the server schema migrations,
seeds deterministic food and exercise catalog fixtures, and then runs the same
integration and contract gates. Local runs can still point at a production
mirror, but hosted quality no longer treats catalog-row coverage as skipped.

The test lane uses deterministic doubles. It does not perform production
database writes, provider purchases, webhook mutations, or deployment actions.
Live RevenueCat evidence remains a separate read-only lane and is blocked when
the required provider credentials or exact deployment evidence are unavailable.
