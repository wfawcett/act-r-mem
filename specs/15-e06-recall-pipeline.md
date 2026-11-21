# Spec: E06 Recall pipeline — card #15

## Goal
A service-internal recall pipeline (`apps/service/src/recall/pipeline.ts`) that, given a query, explicit cues and a session, seeds cues (embedding + explicit), loads neighborhoods, spreads and scores via `packages/activation`, returns the three lanes (associative, exposure `via` episode, direct fact) in a §8-shaped response with a ≤`CONTEXT_MAX_CHARS` text form, writes one `recall_trace` row after responding, and exposes `POST /api/recall/prefetch` with per-(client,session) caching and a 2 s internal budget — without ever reinforcing state.

## Approach
- `apps/service/src/recall/pipeline.ts` — `export async function recall(input: RecallInput, deps: RecallDeps): Promise<RecallResult>`, `RecallInput { tenant: string; sessionId: string; query: string; explicitCues: { id?: string; label?: string }[]; client?: string; now?: number }`. Steps follow PRD §10.5 exactly: session upsert (FR-25), `embed(query)`; on embedding failure log and continue with explicit cues only (no 500). Seed via `SELECT id, 1 - (embedding <=> $q) AS sim … LIMIT seedK`, filter `sim >= seedMinSim`, weight = sim; merge explicit cues at weight 1.0; label cues resolved by `label_norm` then alias. Hop-by-hop edge loading (≤`hops` queries), stop at `maxExpanded` nodes; then `spread` + `score` from `@recall/activation`. Exposure lane: valid neighbors of each recalled episode not already present, `lane: "exposure"`, `via` = episode id (dormant neighbors included, FR-13). Direct lane: best matching fact when `sim >= directMinSim`, `lane: "direct"` (FR-14). Text form: one memory per line with ids, truncated to `CONTEXT_MAX_CHARS` (FR-18).
- `apps/service/src/recall/trace.ts` — `writeTrace(...)` inserts one `recall_trace` row (cues, flows with amounts ≥ 0.004, recalled rows, params, duration) after the response is sent; a failure is logged, never thrown (FR-15). Recall calls no `reinforceEdge`/`recordAccess` (FR-16 — assertion test).
- `apps/service/src/recall/prefetch.ts` — `runPrefetch(client, sessionId, query, deps)`; internal budget 2000 ms via `AbortSignal.timeout` on the embedding call and pipeline steps; on budget expiry or embedding failure return `{ text: "" }` (FR-17, NFR-04). Per-`(client, session_id)` in-memory cache with `PREFETCH_TTL_SECONDS`; cache hit returns without embedding.
- `apps/service/src/http/routes.ts` (new; E09/E10 reuse the pipeline, but the prefetch route itself is this card) — registers `POST /api/recall/prefetch` returning the injectable text block; route errors degrade to empty context, never 500.
- `apps/service/src/recall/deps.ts` — `RecallDeps { embed(text: string): Promise<number[]>; db: pg.PoolClient-executor; params: Params }` so tests inject the stub LiteLLM client and a live test-db.
- Tests in `apps/service/test/recall.integration.test.ts` (compose `test` profile) — per FR: FR-11 response matches §8 (structured rows + text form); FR-12 explicit ids/labels merged at weight 1.0; FR-13 dormant neighbors appear with `lane: "exposure"`; FR-14 best fact below/above `directMinSim`; FR-15 exactly one trace row per recall; FR-16 `access_count`/edge `strength` unchanged after repeated recalls; FR-17 cache hit skips embed (stub call count), TTL expiry re-embeds; FR-18 text ≤ `CONTEXT_MAX_CHARS`; embedding stub failure → recall still returns (explicit cues only), never 500; slow embed stub (>2 s) → prefetch returns empty text within budget (NFR-04). `apps/service/test/recall.latency.test.ts` — on the benchmark fixture scale (seeded fixture via `db/migrate.mjs` + fixture loader), p95 recall latency < 150 ms without embed and < 400 ms with embed (NFR-01/02, smoke numbers; full bench lands in E14).

## Verification
```
docker compose --profile test up -d test-db \
  && DATABASE_URL=postgres://recall:recall@localhost:5433/recall_test pnpm --filter @recall/service test:integration
```
Proving output: vitest passes `recall.integration.test.ts` (all FR-11..FR-18 cases incl. embedding-failure degradation) and `recall.latency.test.ts` reports the p95 latency assertions met at fixture scale. `pnpm --filter @recall/service build` compiles clean under strict TS.

## Out of scope
MCP tools and remaining HTTP routes (E09/E10); the full bench script (E14); reinforcement flush/worker (E07); extraction/ingest; UI; Phase-3 SQL backend swap.
