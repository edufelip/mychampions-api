# QA Smoke Pack — MyChampions main API (`server`)

## Purpose

Default smoke when Skill surface is `api` for the MyChampions family.

## Pack contents

| Layer | What runs | Notes |
|---|---|---|
| Automated | `bun test` (cwd `server`) | Or parent `bun run server:test` from `~/Projects/MyChampions` |
| Human pass | Contract / security / data-shape slice | Auth session + protected route fail-closed; no prod mutations |

## Minimum checkpoints

1. Unauthenticated protected routes fail closed (401/403 as documented).
2. Email/session (or documented local auth) happy path still matches README session contract when exercised.
3. Error payloads do not leak stack traces/secrets in the exercised paths.
4. No speculative concurrency hunt — only document-named idempotency (e.g. refresh replay) if in scope.

## Out of pack

- Food/exercise microservice internals (use `surface=food` / `surface=exercises`).
- Mobile UI / Playwright (use `surface=mobile` or `web`).
- Production writes.

## Related

- Family adapter: global Skill `families/mychampions.md`
- Server README session/auth sections
