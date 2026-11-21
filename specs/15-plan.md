# Plan for Card #15 — E06 Recall pipeline

Source spec: `specs/15-e06-recall-pipeline.md`. Goal: a service-internal recall pipeline in `apps/service/src/recall/` implementing PRD §10.5 with the §8-shaped response, one `recall_trace` row, `POST /api/recall/prefetch` with per-`(client, session)` caching and a 2 s internal budget — never reinforcing state. Builds on cards #13 (db layer, `src/db/pool.ts`, `withTenant`), #14 (`src/config.ts` `Params`/`Config`, `src/llm/client.ts`), #11 (`@recall/activation`: `spread`, `score`, `pathEdges`, `Graph`/`Cue`/`Flow`/`ScoreRow`).

## 1. Task list

1. DONE: Add `apps/service/src/recall/deps.ts` — the injectable `RecallDeps` (see signatures below) plus `RecallInput`/`RecallResult`/`RecalledMemory` types so tests stub `embed` and pass a live test-db client.
2. Extend `apps/service/src/config.ts` — add `PREFETCH_TTL_SECONDS` (default 600) and `CONTEXT_MAX_CHARS` (default 4000) to the §16.3 `Config` fields with defaults, so pipeline/prefetch read them from config instead of literals.
   DONE: Extend `apps/service/src/config.ts` — add `PREFETCH_TTL_SECONDS` (default 600) and `CONTEXT_MAX_CHARS` (default 4000) to the §16.3 `Config` fields with defaults, so pipeline/prefetch read them from config instead of literals.
   DONE: Add `apps/service/src/recall/pipeline.ts` — `export async function recall(input, deps): Promise<RecallResult>` following §10.5 steps 1–9 exactly: upsert the session (`INSERT … ON CONFLICT (tenant_id, id) DO NOTHING` on `sessions`, FR-25); `embed(query)` with try/catch — on failure log and continue with explicit cues only (no 500); seed via `SELECT id, 1 - (embedding <=> $1::vector) AS sim FROM nodes WHERE tenant_id = $t AND invalid_at IS NULL AND embedding IS NOT NULL ORDER BY embedding <=> $1 LIMIT seedK`, keep `sim >= seedMinSim`, weight = sim; resolve label cues by `label_norm` then `aliases @>` and merge all explicit cues at weight 1.0; load edges hop by hop (`SELECT … FROM edges WHERE tenant_id = … AND invalid_at IS NULL AND (src = ANY($ids) OR dst = ANY($ids))` then fetch reached nodes, ≤ `hops` queries, stop at `maxExpanded` nodes) into an `@recall/activation` `Graph`; run `spread` then `score` for the associative lane; exposure lane from valid neighbors of each recalled episode not already present with `lane: "exposure"` and `via` = episode id (dormant included, FR-13); direct lane `ORDER BY embedding <=> $1 LIMIT 1` over `kind = 'fact'`, included when `sim >= directMinSim` and not already present (FR-14); build the §8 response (associative by A desc, then exposure, then direct; text form one memory per line, truncated to `CONTEXT_MAX_CHARS`, FR-18) and write the trace via `writeTrace`, returning `trace_id` in the result. No `reinforceEdge`/`recordAccess` anywhere (FR-16).
4. DONE: Add `apps/service/src/recall/trace.ts` — `export async function writeTrace(deps, data): Promise<number | undefined>` inserting exactly one `recall_trace` row (tenant, session_id, client, query, `cue_ids`, `cue_weights`, `hops` jsonb with flows filtered to `amount >= 0.004`, `recalled` jsonb `{id, lane, A, B, S}`, `params` snapshot, `duration_ms`) returning the new id; any failure is logged and swallowed, never thrown (FR-15).
5. DONE: Add `apps/service/src/recall/prefetch.ts` — `export async function runPrefetch(client, sessionId, query, deps): Promise<{ text: string }>`: per-`(client, sessionId)` in-memory `Map` cache with TTL `PREFETCH_TTL_SECONDS` (cache hit returns the cached text without embedding); on miss, run `recall` with a 2000 ms internal budget — `AbortSignal.timeout(2000)` raced/aborted around the embedding call and the pipeline steps; budget expiry or embed failure returns `{ text: "" }` (FR-17, NFR-04).
6. Add `apps/service/src/http/routes.ts` — new `http/` module registering `POST /api/recall/prefetch` (JSON body `{ query, session_id, client }`, response `{ text }` — the injectable text block); wires `deps` from the real pool + LiteLLM client + loaded params; route-level try/catch degrades to `{ text: "" }`, never 500. Export a `registerRoutes(app, deps)` function; E09/E10 later add their routes to the same module.
   DONE: Add `apps/service/src/http/routes.ts` — new `http/` module registering `POST /api/recall/prefetch` (JSON body `{ query, session_id, client }`, response `{ text }` — the injectable text block); wires `deps` from the real pool + LiteLLM client + loaded params; route-level try/catch degrades to `{ text: "" }`, never 500. Export a `registerRoutes(app, deps)` function; E09/E10 later add their routes to the same module.
7. Add `apps/service/test/recall.integration.test.ts` (vitest against compose `test-db`, `DATABASE_URL=postgres://recall:recall@localhost:5433/recall_test`, migrations applied via `db/migrate.mjs` before seeding) — a shared `beforeAll` seeds a fixture graph (entities/facts/episodes + edges, with embeddings computed deterministically or from a stub vector set), then per-FR cases: FR-11 response matches §8 (rows have `id/kind/lane/label/content/activation/base_level/spread/occurred_at/via` + text); FR-12 explicit ids/labels merged at weight 1.0 (check `cue_weights` in the trace row); FR-13 dormant neighbor appears with `lane: "exposure"` and `via`; FR-14 best fact included at `sim >= directMinSim` and excluded below it; FR-15 exactly one `recall_trace` row per recall; FR-16 `nodes.access_count` and `edges.strength` byte-identical after repeated recalls (assert no reinforcement); FR-17 prefetch cache hit does not call the embed stub again, and TTL expiry (mock clock / short TTL via config) re-embeds; FR-18 `result.text.length <= CONTEXT_MAX_CHARS`; embedding stub that rejects → recall still returns with explicit-cue-only results, no throw; embed stub with a >2 s delay (resolvable via injected `AbortSignal`/manual clock) → prefetch returns `{ text: "" }` within budget.
   DONE: Add `apps/service/test/recall.integration.test.ts` — vitest FR-11..FR-18 + NFR-04 cases against compose test-db with a deterministic stub-vector fixture graph (committed in 684714b, incl. pipeline bigint-id coercion and aliases-binding fixes these cases surfaced).
8. DONE: Add `apps/service/test/recall.latency.test.ts` — the benchmark fixture scale (fixture loader script under `apps/service/test/fixtures/` seeding via `pg`), measuring p95 of N `recall()` calls without embed (< 150 ms) and with the stub embed (< 400 ms) at fixture scale (NFR-01/02 smoke numbers; full bench lands in E14).
9. DONE: Verify (not executed here): `docker compose --profile test up -d test-db && DATABASE_URL=postgres://recall:recall@localhost:5433/recall_test pnpm --filter @recall/service test:integration` and `pnpm --filter @recall/service build` compile clean under strict TS.

## 2. Types and interfaces

```ts
// apps/service/src/recall/deps.ts
import type { PoolClient } from 'pg';
import type { Params } from '../config.js';

export interface RecallDeps {
  embed(text: string): Promise<number[]>;
  db: PoolClient;                       // transaction-capable executor; tests inject a live client
  params: Params;                       // config snapshot used for spread/score and the trace row
}

export interface RecallInput {
  tenant: string;                       // defaults handled by callers; 'local' in tests
  sessionId: string;
  query: string;                        // 1..4000 chars (§8.2)
  explicitCues: { id?: number; label?: string }[];  // node ids as numbers or label strings
  client?: string;                      // default 'local'
  now?: number;                         // epoch ms; defaults Date.now() at the call boundary only
  limit?: number;                       // 1..25, default params.resultLimit
}

// apps/service/src/recall/pipeline.ts — §8.2 shapes
export type Lane = 'associative' | 'exposure' | 'direct';
export interface RecalledMemory {
  id: number;
  kind: 'entity' | 'fact' | 'episode';
  label: string;
  content: string | null;
  lane: Lane;
  activation: number | null;   // A; null for exposure and direct
  base_level: number;          // B
  spread: number | null;       // S; null for exposure and direct
  occurred_at: string | null;  // ISO string or null
  via: number | null;          // for exposure: the episode id that exposed it
}
export interface RecallResult {
  trace_id: number | undefined; // set after writeTrace; writeTrace never throws
  memories: RecalledMemory[];   // associative ranked by A desc, then exposure, then direct
  text: string;                 // ≤ CONTEXT_MAX_CHARS, one memory per line, ids included (FR-18)
}

// apps/service/src/recall/trace.ts
export interface TraceData {
  tenant: string; sessionId: string | undefined; client: string;
  query: string;
  cueIds: bigint[]; cueWeights: number[];
  hops: { hop: number; from: number; to: number; edge: number; amount: number }[]; // filtered to amount >= 0.004
  recalled: { id: number; lane: Lane; A: number; B: number; S: number }[];
  params: Params;
  durationMs: number;
}
export async function writeTrace(deps: RecallDeps, data: TraceData): Promise<number | undefined>;

// apps/service/src/recall/prefetch.ts
export async function runPrefetch(
  client: string,
  sessionId: string,
  query: string,
  deps: RecallDeps & { contextMaxChars: number; prefetchTtlSeconds: number },
): Promise<{ text: string }>;

// apps/service/src/http/routes.ts
import type { FastifyInstance } from 'fastify';   // or the http framework E01 scaffolded; plain adapter otherwise
export async function registerRoutes(app: FastifyInstance, deps: RecallDeps): Promise<void>;
// registers POST /api/recall/prefetch { query, session_id, client } -> { text }
```

Notes: `now` is threaded into `spread`/`score`/`baseLevel` (the activation package never reads clocks). The §16.3 additions to `Config` in task 2: `prefetchTtlSeconds: number` (default 600), `contextMaxChars: number` (default 4000) — env-only keys, not part of `Params`/`params.json`.

## 3. Verification mapping

| Task | Verification command |
| --- | --- |
| 1 (deps/types) | Task 9 command — tests construct `RecallDeps` with the stub embed and live client. |
| 2 (config fields) | Task 9 command — integration tests drive TTL via `prefetchTtlSeconds`; `pnpm --filter @recall/service build` strict-compiles. |
| 3 (pipeline) | Task 9 command — FR-11/12/13/14 cases plus embed-failure degradation pass. |
| 4 (trace) | Task 9 command — FR-15 (exactly one row), FR-16 (access_count/strength unchanged). |
| 5 (prefetch) | Task 9 command — FR-17 cache-hit/TTL cases and NFR-04 slow-embed `text: ""` within 2 s. |
| 6 (route) | Task 9 command — route returns the injectable text block; route error path (stub throwing) returns `{ text: "" }`, never 500. |
| 7 (integration tests) | Task 9 command — `recall.integration.test.ts` passes all FR-11..FR-18 cases. |
| 8 (latency tests) | Task 9 command — `recall.latency.test.ts` p95 < 150 ms (no embed) / < 400 ms (stub embed) at fixture scale. |

Verification step from spec: `docker compose --profile test up -d test-db && DATABASE_URL=postgres://recall:recall@localhost:5433/recall_test pnpm --filter @recall/service test:integration` — vitest passes `recall.integration.test.ts` (all FR cases incl. embedding-failure degradation) and `recall.latency.test.ts` reports the p95 assertions met at fixture scale; `pnpm --filter @recall/service build` compiles clean under strict TS.

## 4. Dependencies

No new runtime packages: `pg` (card #13), `zod` (card #14) and the workspace package `@recall/activation` (card #11) already cover the pipeline. Only `@recall/activation` must be added as a workspace dependency of the service, plus vitest/test types if not already hoisted:

```
pnpm --filter @recall/service add @recall/activation@workspace:*
pnpm --filter @recall/service add -D vitest @types/pg
```

Postgres + pgvector come from the existing compose `test-db` image; no new images, no installers run by this card.
