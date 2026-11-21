# Implementation Plan — Card #16 (E07 Ingest queue and worker)

Source spec: `specs/16-ingest-queue-worker.md` (highest matching `16-*`; `specs/16-e07-ingest-queue-and-worker.md` describes the same card and was cross-checked — where the two differ, e.g. `enqueueRemember(payload)` vs `enqueueRemember(input, config)`, this plan follows the higher file and the PRD's `RememberOutput = { queued_id: number }`).

Everything lives in `apps/service` on top of what already exists: `src/config.ts` (`loadConfig`, `getParams`, `params.extractWindowChars` = 6000, `workerConcurrency` = 2), `src/db/pool.ts` + `src/db/tenant.ts` (`withTenant`), `src/llm/client.ts` (`createClient` → `embed`/`extract`/`judge`, `ExtractionSchema`), the §6.1 schema in `db/migrations/0001_init.sql` (`ingest_queue`, `nodes` with `label_norm`/`aliases`/`embedding vector(768)`/`recent_access`, `edges` with unique `(tenant_id, src, dst, predicate) WHERE invalid_at IS NULL`), and `test/stub-litellm.ts`. No file in `specs/`, `db/`, or E02–E05 code is modified.

## 1. Task list

1. DONE: Add `apps/service/src/ingest/redact.ts` — `redact(text)`: ordered regexes for PEM private keys, `Bearer <tok>` headers, `sk-`-style keys, `ghp_` tokens, AWS `AKIA…` access keys, and `scheme://user:password@host` URLs, each replaced with `[redacted]`; exported pattern list so the NFR-11 test can assert coverage.
2. Add `apps/service/src/ingest/window.ts` — `windowTurns(turns, maxChars)`: greedily pack transcript turns into windows of at most `maxChars` characters, never splitting inside a turn (a single oversized turn is its own window); returns `[]` for empty input.
DONE: Add apps/service/src/ingest/window.ts — windowTurns(turns, maxChars): greedily pack transcript turns into windows of at most maxChars characters, never splitting inside a turn (a single oversized turn is its own window); returns [] for empty input.
3. Add `apps/service/src/ingest/enqueue.ts` — zod schemas for `RememberInput` (§8.1: text 1..20000, optional `occurred_at`/`session_id`/`client`/`structured`) and `TranscriptRequest` (§9.2: 1..200 turns), then `enqueueRemember` / `enqueueTranscript`: validate, derive `tenantId = 'local'`, and do exactly one `INSERT INTO ingest_queue (tenant_id, kind, client, session_id, payload) VALUES (…, 'pending')` via `pool`, returning `{ queued_id }`; `payload` stores `{ text, occurred_at, structured? }` for remember and `{ turns }` for transcript — no LLM, embed, or activation call anywhere in the module.
4. Add `apps/service/src/ingest/resolve.ts` — `resolveEntities(labels, tenantId, client, opts)`: per label, resolution order exact `label_norm` (lower(trim(label))) → alias membership among valid entities → embedding cosine ≥ `entityMergeSim` (embedding computed from the label); a similarity match adds the new label as an alias on the existing entity; every match records one access at `opts.at` (the queue item's `created_at`) — `access_count + 1`, `recent_access = array_prepend(at, …)` trimmed to `params.recentAccesses` (FR-07) — and runs inside the caller's transaction client.
5. Add `apps/service/src/ingest/extract.ts` — thin wrapper over `client.extract`: build the §11.3 user content (redacted text or serialized window), call per window, and merge window results by entity `key` into one `Extraction` (dedupe episodes/facts/edges by key; concatenate arrays across windows).
6. Add `apps/service/src/ingest/process.ts` — `processItem(item, deps)`: inside one `withTenant(item.tenant_id, …)` transaction run §11.2 in order — redact (§11.2.1, also applied to every log/error string) → window (transcript windows via `windowTurns`; remember is a single window) → skip `extract()` when `payload.structured` validates (FR-05, §11.5) → `resolveEntities` (FR-06) → create new episodes (`occurred_at` from extraction, else earliest turn time of the window / item time), entities, facts → create edges from the extraction plus `mentioned_in`/`incidental` links for every entity and fact mentioned in an episode, reinforcing an existing valid `(src, dst, predicate)` edge (`strength` bump + `last_used_at`) instead of duplicating it (unique index makes this an upsert-on-conflict) → batch `embed()` of all new/changed nodes (`label + '\n' + content`) and write embeddings as pgvector text literals `'[…]'::vector` (FR-08) → per new fact, contradiction check: candidate valid facts on the same subject with embedding cosine ≥ `contradictionSim` (0.85), `client.judge()` on each; on yes set old fact `invalid_at = now()`, `superseded_by = new id`, and `invalid_at` on its edges (FR-09, §11.4) → implicit use for transcripts (FR-23): load this session's `recall_trace` rows, take the labels of recalled/used nodes, case-insensitive word-boundary match (`\blabel\b` on `toLowerCase`) against assistant turns **after** each trace's `at`, and record an access + edge reinforcement for matches — all model calls receive redacted text only. Zero entities + zero facts + zero episodes ⇒ still commit, return `done` and the caller marks the row `done` with metadata `{empty: true}` (§11.5).
7. Add `apps/service/src/ingest/worker.ts` — `startWorker(pool, config)`: `config.workerConcurrency` slots each polling every 1 s and claiming with the §11.1 statement (`UPDATE ingest_queue SET status='processing', started_at=now(), attempts=attempts+1 WHERE id = (SELECT id FROM ingest_queue WHERE status='pending' AND run_after <= now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`); on `'retry'`/throw: `attempts < 5` ⇒ `status='pending'`, `run_after = now() + 2^attempts seconds`, `last_error = redact(message)`, else `status='failed'`; on startup and every 5 min requeue items stuck `processing` > 10 min (`status='pending'`, clear `started_at`); `stop()` sets a stop flag, stops claiming, and awaits all in-flight `processItem` promises before resolving.
8. Add `apps/service/src/routes/ingest.ts` and `apps/service/src/index.ts` — Fastify instance with `POST /api/ingest/transcript` (zod-validate, call `enqueueTranscript`, reply `{ queued_id }`; invalid body ⇒ 400), a healthz stub, and the entrypoint: `loadConfig(env)` → run `db/migrate.mjs` via child process or inline runner → `fastify.listen` → `startWorker` → on `SIGTERM`/`SIGINT` `await worker.stop()` then `fastify.close()`; add `"start": "node dist/index.js"` to `apps/service/package.json`.
9. Add `apps/service/test/ingest.integration.test.ts` — vitest suite against compose `test-db` (localhost:5433) + `stub-litellm.ts`: FR-01/02 (one `pending` row per enqueue, `chatLog` empty at enqueue time, enqueue p95 < 30 ms), FR-05 (structured remember makes zero `chat/completions` calls), FR-06/07 (exact/alias/similarity merge + access bump with `recent_access` trimmed), FR-08 (non-null `embedding` on new nodes after processing), FR-09 (contradicting fact sets `invalid_at`/`superseded_by` and invalidates old edges), FR-10 (re-sending an identical `(client, session_id, turns)` transcript creates no new nodes/episodes), FR-23 (implicit use bumps the recalled node's access), §11.5 (`{empty: true}` done), SKIP LOCKED double-claim (two concurrent claims return different items), retry/backoff (stub 500 ⇒ `pending` with growing `run_after`, `failed` + `last_error` on attempt 5), stuck-item requeue, graceful `stop()`, and the NFR-11 corpus (fake private key / bearer / `sk-` / `AKIA` / `user:pass@` strings seeded through remember+transcript never appear in any `stub.state.chatLog` body or captured stderr); kill-mid-ingest case spawns the worker as a child process (`node dist/index.js` after `pnpm --filter @recall/service build`, `spawn` from `node:child_process`), kills it with `SIGKILL` mid-processing, restarts, and asserts the item ends `done` — including an enqueued-but-never-claimed `{empty: true}` item.

## 2. Types and interfaces

```ts
// apps/service/src/ingest/redact.ts
export const REDACTION = '[redacted]';
export const REDACT_PATTERNS: RegExp[];              // private keys, bearer, sk-/ghp_, AKIA, user:password@
export function redact(text: string): string;

// apps/service/src/ingest/window.ts
export interface TranscriptTurn { index: number; role: 'user' | 'assistant'; content: string; at: string; }
export function windowTurns(turns: TranscriptTurn[], maxChars: number): TranscriptTurn[][];

// apps/service/src/ingest/enqueue.ts
export interface RememberStructured {
  entities: { label: string; aliases?: string[] }[];
  facts: { subject: string; statement: string; half_life_class?: 'identity' | 'default' | 'incidental' }[];
  episode?: { label: string; summary: string };
  edges: { from: string; to: string; predicate: string; half_life_class?: 'identity' | 'default' | 'incidental' }[];
}
export interface RememberInput {
  text: string;            // 1..20000 chars
  occurred_at?: string;    // ISO 8601
  session_id?: string;
  client?: 'claude-code' | 'hermes' | 'omp' | 'manual';
  structured?: RememberStructured;
}
export interface TranscriptRequest {
  client: 'claude-code' | 'hermes' | 'omp';
  session_id: string;
  turns: TranscriptTurn[]; // 1..200
}
export const RememberInputSchema: z.ZodType<RememberInput>;
export const TranscriptRequestSchema: z.ZodType<TranscriptRequest>;
export function enqueueRemember(input: RememberInput, config: Config): Promise<{ queued_id: number }>;
export function enqueueTranscript(req: TranscriptRequest, config: Config): Promise<{ queued_id: number }>;

// apps/service/src/ingest/resolve.ts
export interface ResolveOptions { at: Date; }        // queue item's created_at (FR-07)
export function resolveEntities(
  labels: string[],
  tenantId: string,
  client: ReturnType<typeof createClient>,
  opts: ResolveOptions,
): Promise<Map<string, number>>;                     // label → resolved node id (new or existing)

// apps/service/src/ingest/extract.ts
export function extractFromWindows(
  windows: string[],                                 // already redacted
  client: ReturnType<typeof createClient>,
  requestId?: string,
): Promise<Extraction>;                              // merged by entity key (Extraction from llm/client.ts)

// apps/service/src/ingest/process.ts
export const Constants = { entityMergeSim: 0.92, contradictionSim: 0.85 } as const;
export interface QueueItem {                         // RETURNING * row of ingest_queue
  id: number; tenant_id: string; kind: 'remember' | 'transcript'; client: string;
  session_id: string | null; payload: { text?: string; occurred_at?: string; structured?: RememberStructured; turns?: TranscriptTurn[] };
  status: 'pending' | 'processing' | 'done' | 'failed'; attempts: number;
  run_after: Date; last_error: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null;
}
export interface ProcessDeps {
  client: ReturnType<typeof createClient>;
  config: Config;
  now?: () => Date;                                  // injectable clock for tests
}
export async function processItem(item: QueueItem, deps: ProcessDeps): Promise<'done' | 'retry' | 'failed'>;
// 'done'   → caller marks finished_at = now(); empty extraction is 'done' with {empty:true} metadata on the row
// 'retry'  → caller applies backoff (attempts < 5) or 'failed'
// 'failed' → unrecoverable validation/transaction error

// apps/service/src/ingest/worker.ts
export interface WorkerHandle { stop(): Promise<void>; }
export function startWorker(pool: Pool, config: Config): WorkerHandle;

// apps/service/src/routes/ingest.ts
export interface BuildAppOptions { config: Config; }
export function buildApp(opts: BuildAppOptions): Promise<FastifyInstance>;  // registers POST /api/ingest/transcript (+ /healthz)
// apps/service/src/index.ts
export async function main(env?: NodeJS.ProcessEnv): Promise<void>;         // loadConfig → migrate → listen → startWorker → SIGTERM/SIGINT stop
```

Notes: `Extraction` and the LLM client are reused from `src/llm/client.ts` — no second schema. Embeddings are written as `'[…]::vector` string literals through `pg`, so no pgvector npm package is needed. The `MCP` `remember` tool (E09) will call `enqueueRemember` directly; it is only exercised via the function here.

## 3. Verification mapping

Spec verification command (run after `docker compose --profile test up -d test-db`, with `DATABASE_URL=postgres://recall:recall@localhost:5433/recall_test` and `LITELLM_BASE_URL=http://127.0.0.1:<stub-port>/v1`):

```
pnpm --filter @recall/service test
```

| Task | Exercising test case in `test/ingest.integration.test.ts` |
| --- | --- |
| 1 redact.ts | NFR-11 corpus: each pattern replaced by `[redacted]`; no corpus string in stub `chatLog` bodies or captured stderr/log output. |
| 2 window.ts | Transcript > 6000 chars splits on turn boundaries; every window ≤ `extractWindowChars`; no turn split in half; single oversized turn stays whole. |
| 3 enqueue.ts | FR-01/02: exactly one `pending` row per call, correct `kind`/`client`/`session_id`/`payload`; `completionCount(stub) === 0` after enqueue; enqueue p95 < 30 ms; invalid payload → zod error before any INSERT. |
| 4 resolve.ts | FR-06: exact `label_norm`, alias, and ≥0.92-similarity merge (alias added); FR-07: matched node `access_count` +1 with one `recent_access` at the item's `created_at`, trimmed to `recentAccesses`. |
| 5 extract.ts | Transcript produces one merged `Extraction` across windows; FR-05: structured remember makes zero `/chat/completions` calls; `{empty: true}` case for nothing-worth-keeping output. |
| 6 process.ts | FR-08 embeddings set after one worker cycle; FR-09 supersession (`invalid_at`, `superseded_by`, old edges invalidated); FR-10 identical re-sent transcripts create no new rows; `mentioned_in`/`incidental` links with reinforcement not duplication; FR-23 implicit-use access bump on the recalled node. |
| 7 worker.ts | SKIP LOCKED: two concurrent claims never return the same item; stub-500 item: `pending` with growing `run_after`, `failed` + `last_error` on attempt 5; stuck-`processing` > 10 min requeued; `stop()` drains an in-flight item. |
| 8 routes/entrypoint | Route POST returns `{ queued_id }` with one row; child-process worker (used by the kill test) boots via the entrypoint, so migrations + worker start + signal handling are exercised by it. |
| 9 kill-mid-ingest | `SIGKILL` between enqueue and completion, restart ⇒ item still completes; `{empty: true}` never-claimed case completes after restart. |

## 4. Dependencies

No new runtime packages beyond one addition for the routes/entrypoint (Fastify is not yet a dependency of `@recall/service`):

```
pnpm --filter @recall/service add fastify
```

Already satisfied: `pg` (pool, claims, vector literals), `zod` (validation, reuse of `ExtractionSchema`), `vitest` (workspace root). No new packages for pgvector (string-literal casting), stub server (`node:http`), or child-process kill test (`node:child_process`).
