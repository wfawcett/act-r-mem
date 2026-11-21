# E07 — Ingest queue and worker (card #16)

## Goal
When done, `remember` and `POST /api/ingest/transcript` only insert `ingest_queue` rows (p95 < 30 ms, no model call in the request path), and a background worker processes each item through the §11.2 pipeline (redaction, windowing, extraction, entity resolution, access recording, `mentioned_in` linking with reinforcement, embedding, contradiction supersession, implicit use), with SKIP LOCKED claiming, backoff to 5 attempts, stuck-item requeue, graceful shutdown, and no queue item lost across kill/restart.

## Approach
Files to create or change:
- `apps/service/src/ingest/enqueue.ts` — `enqueueRemember(input, config): Promise<{queuedId}>` and `enqueueTranscript(req, config): Promise<{queuedId}>`; single-row INSERT into `ingest_queue` (`kind` remember|transcript, `client`, `session_id`, `payload` jsonb), no LLM/embed calls; zod validation of `RememberInput` (§8.1) and `TranscriptRequest` (§9.2).
- `apps/service/src/ingest/redact.ts` — `redact(text: string): string`; regexes for private keys, bearer tokens, `sk-` keys, AWS access keys, passwords in URLs → `[redacted]` (§11.2 step 1, NFR-11). Applied before any `extract()`/`embed()` call and to all log lines.
- `apps/service/src/ingest/window.ts` — `windowTurns(turns, maxChars): Turn[][]`; splits on turn boundaries under `config.params.extractWindowChars` (E05 already ships it, 6000).
- `apps/service/src/ingest/process.ts` — `processItem(item, deps): Promise<'done'|'retry'|'failed'>`; runs §11.2 steps inside one `withTenant` transaction: redact → window → `extract()` per window (skipped when `payload.structured` is valid, FR-05) merged by entity label → `resolveEntities` (FR-06) → create episodes/entities/facts → edges + `mentioned_in` (incidental class; existing valid `(src,dst,predicate)` edge is reinforced, not duplicated) → batch `embed()` of new/changed nodes (FR-08) → `judge()` contradiction checks (FR-09, similarity threshold 0.85, `invalid_at`/`superseded_by` on old fact and its edges) → implicit use for transcripts (FR-23: labels of nodes in `recall_trace` for that session, case-insensitive word-boundary match on assistant turns after the recall) → mark `done`; empty extraction → `done` with payload metadata `{empty: true}` (§11.5). Exports `Constants = { entityMergeSim: 0.92, contradictionSim: 0.85 }`.
- `apps/service/src/ingest/resolve.ts` — `resolveEntities(labels, tenantId, client): Promise<Map<key, nodeId>>`; exact `label_norm` → alias → embedding cosine ≥ `entityMergeSim` (merge adds alias); each match records one access at the queue item's `created_at`, `recent_access` trimmed to `recentAccesses` (FR-07).
- `apps/service/src/ingest/worker.ts` — `startWorker(pool, config): { stop(): Promise<void> }`; `WORKER_CONCURRENCY` slots polling every 1 s, claim with the §11.1 `UPDATE … FOR UPDATE SKIP LOCKED` statement; on error: attempts < 5 → `pending`, `run_after = now() + 2^attempts s`, `last_error`; else `failed`; requeues items stuck `processing` > 10 min at startup and every 5 min; `stop()` stops claiming, awaits in-flight items, exits.
- `apps/service/src/routes/ingest.ts` — Fastify routes wired to the enqueue functions; service entrypoint starts the worker after migrations and calls `stop()` on SIGTERM/SIGINT.
- `apps/service/test/ingest.integration.test.ts` — vitest suite against compose `test-db` + `stub-litellm.ts` covering FR-01..FR-10, FR-23; NFR-11 secret corpus test asserts no corpus string in any captured stub request body or log output; kill-mid-ingest test kills the process between enqueue and completion, restarts, and asserts the item still completes (`{empty: true}` case included).

## Verification
```
docker compose --profile test up -d test-db \
  && DATABASE_URL=postgres://recall:recall@localhost:5433/recall_test \
     LITELLM_BASE_URL=http://127.0.0.1:<stub-port>/v1 \
     pnpm --filter @recall/service test
```
Proving output: vitest passes — enqueue routes insert exactly one `pending` row with no stub-model call recorded and p95 < 30 ms; two concurrent workers never process one item; a stub-500 item retries with growing `run_after` and ends `failed` with `last_error` on attempt 5; a killed worker's in-flight item is requeued and finishes after restart; resolved entities get access bumps; new nodes carry embeddings; a contradicting fact supersedes the old one; re-sent identical transcripts create no new rows; the NFR-11 corpus never appears in stub-captured prompts or logs.

## Out of scope
MCP (`/mcp`) and remaining HTTP/UI surfaces (E09/E10); reinforcement buffer flush (E08); model choice/registration behind LiteLLM (`EXTRACT_MODEL` is config only); recall pipeline (E06); nightly 30-day queue purge and LISTEN/NOTIFY optimization.
