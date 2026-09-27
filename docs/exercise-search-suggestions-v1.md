# Exercise search and explicit semantic suggestions v1

This document defines the ET-229 server contract. It is an implementation and review record; it does not enable a provider or authorize deployment.

## Boundaries

`POST /integrations/exercise/search` remains the ordinary authenticated catalog path. It never instantiates or calls TypeSafe. `POST /integrations/exercise/suggest` is a separate authenticated path and requires a literal `consent: true` on every request. The server owns the TypeSafe credential and sends only catalog candidate metadata. The mobile client receives a suggestion for an existing returned ID; the model cannot generate an exercise, prescription, instruction, plan mutation, or video URL.

The two server flags are exact string booleans and default to false:

- `EXERCISE_SEARCH_V2_ENABLED` enables bounded normalized token retrieval and deterministic ranking.
- `EXERCISE_SUGGESTIONS_ENABLED` permits provider calls only when retrieval is also enabled.

`TYPESAFE_API_KEY` is optional at startup. If it is absent, a suggestion request returns deterministic catalog results with `status: "unavailable"`; ordinary search remains available. The pinned model defaults to `jev-1.13.0`, the provider deadline is 100–2000 ms (default 900), and the exploratory confidence floor defaults to 0.90.

## Retrieval and eligibility

V2 normalizes NFKD text, strips combining marks, lowercases and bounds input to 200 Unicode code points and 12 tokens. SQL patterns are parameterized and escape `%`, `_`, and backslash. Matching rows are ranked by exact normalized title/slug, complete movement alias coverage, token match count, title prefix, equipment agreement, title, and ID. Deduplication and the 50-row cap occur after ranking. The response keeps the existing `page: 1`, bounded `pageSize`, `total: results.length`, and `results` contract; it does not claim a corpus total or add pagination.

The equipment parser is conservative and versioned. It recognizes the checked-in EN/PT/ES movement and equipment aliases, phrase-local negation, and exact known equipment metadata. Unknown or ambiguous equipment metadata fails eligibility when a hard constraint is present. Mixed include/exclude requirements, contradictory requirements, generic/unsupported negation, and other unrecognized constraints return `unsupported_query` without a provider call. Lexical results remain available for these requests.

The provider receives at most 20 eligible rows from the same response, each with ID, title, equipment, muscle group, and a description truncated to 500 characters. The adapter validates the pinned model, response shape, finite confidence/probabilities in `[0,1]`, explicit `none`, and candidate membership. The service rechecks membership and hard constraints before returning a suggestion. An unknown ID is `unavailable`; explicit `none` and a confidence below the floor are `no_match`.

## HTTP contract

Request:

```json
{"query":"supino reto com barra","lang":"pt-BR","pageSize":20,"consent":true}
```

The route checks the bearer token before catalog access, validates a non-empty bounded query, language, page size 1–50, and literal consent. Invalid input is 400, missing/invalid auth is 401, user capacity is 429 with `Retry-After: 60`, and catalog failures preserve the existing typed 502/503 gateway response. Evaluated/fallback provider outcomes are HTTP 200 with:

```ts
type SuggestionResponseV1 = {
  schemaVersion: 'exercise-suggestion.v1';
  query: string; lang: string; page: 1; pageSize: number; total: number;
  results: ExerciseItem[];
  suggestion: { exerciseId: string } | null;
  status: 'suggested' | 'no_match' | 'unsupported_query' | 'disabled' | 'unavailable';
};
```

An exact unique title/slug result avoids inference and returns `no_match`. Empty results return `no_match` with zero provider calls. Flags disabled or contradictory return `disabled` with deterministic results. The ordinary endpoint has no provider dependency.

## Limits, privacy, and rollback

The single-process limiter allows five requests per authenticated UID per 60 seconds, three concurrent model calls, and a bounded 10,000-user window map. Five consecutive provider failures open a 60-second circuit; one half-open probe is allowed and a failed probe starts a fresh interval. There is no interactive retry or shared runtime cache. The response body is capped at 256 KiB, and caller cancellation is propagated where the framework permits it.

Normal telemetry records aggregate status, duration, candidate count, model version, and request ID. It does not record raw queries, descriptions, notes, probability maps, auth UIDs, or secrets. Live enablement additionally requires operator spend controls and a frozen held-out evaluation; the current synthetic fixture tests are development evidence only. The required gate is at least 180 labeled queries (at least 60 per locale), frozen corpus/alias/model/threshold versions, no exact-match regression, at least a ten-point held-out recall@20 improvement for non-exact queries, at least 98% semantic precision over at least 50 emitted held-out suggestions, zero hard-constraint violations, and p95 endpoint latency at most 1.5 seconds. Until that evidence exists, both flags remain disabled.

Rollback is configuration-only: disable suggestions, then the app opt-in flag, then V2 retrieval if needed. No database migration is required for v1, and no production provider activation is included in ET-229.

## Validation record

Focused Bun coverage includes query normalization and negation, deterministic candidate ranking, unknown metadata, limiter circuit/half-open behavior, adapter response bounds, auth/consent ordering, ordinary-search zero provider calls, candidate filtering, unknown model IDs, and repeated default-factory calls. The V2 Postgres gateway test uses only `EXERCISE_CATALOG_V2_TEST_DATABASE_URL`, creates and tears down its own synthetic schema and rows, and is provisioned as a separate database in hosted CI. The mirrored catalog is never written by that test. No held-out quality or production latency claim is made from fixtures.
