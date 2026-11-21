# E07 — Ingest queue and worker (card #16)

## Goal
`remember` and the transcript route only insert an `ingest_queue` row (FR-01/02, p95 < 30 ms, no model call), and a background worker drains the queue through the §11.2 pipeline — redaction, windowing, extraction, entity resolution, access recording, linking with `mentioned_in` reinforcement, embedding, contradiction supersession, implicit use — surviving kill/restart without losing items and ending empty extractions as `done` with `{empty: true}`.

## Approach
All under `apps/service/src`, on top of E05's `config.ts`, `llm/client.ts` (`extract`, `embed`, `judge`) and the E03 db layer (`withTenant`, pool):
- `ingest/enqueue.ts` — `enqueueRemember(payload): Promise<{queued_id}>` and `enqueueTranscript(payload)`; zod-validate (`RememberInput` §8.1, `TranscriptRequest` §9.2), then one INSERT into `ingest_queue` (`kind`, `client`, `session_id`, `payload` jsonb, `status='pending'`). No LLM/embed/activation call. FR-05: `remember` with valid structured input stores `{structured, text}` and is later processed without `extract()`.
- `ingest/redact.ts` — `redact(text)`: regexes for private keys, bearer tokens, `sk-`/`ghp_` keys, AWS AKIA keys, `user:password@` URLs → `[redacted]` (NFR-11). Applied before any model call and to all log/error lines.
- `ingest/window.ts` — `windowTurns(turns, maxChars)`: split on turn boundaries at `EXTRACT_WINDOW_CHARS` (6000).
- `ingest/extract.ts` — call `extract()` (§11.3 zod `Extraction` schema, temperature 0); merge window results by entity key.
- `ingest/process.ts` — `processItem(item)`: in one `withTenant` transaction: redact → window (transcript) / single window (remember) → extract unless structured → `resolveEntities` (exact `label_norm` → alias → embedding cosine ≥ `entityMergeSim`; each match records an access with `recent_access` trim, FR-07) → create episodes (`occurred_at` else earliest turn time), entities, facts → edges; every mentioned entity/fact links `mentioned_in`/`incidental`, existing valid `(src,dst,predicate)` edge gets strength reinforcement instead of a duplicate → batch `embed()` of new/changed nodes (FR-08) → per new fact, §11.4 contradiction check (candidates ≥ 0.85 similarity; `judge()` yes → `invalid_at=now()`, `superseded_by`, edges invalidated) → implicit use (FR-23): session `recall_trace` labels matched word-boundary case-insensitively in assistant turns → zero outputs ⇒ update item `done` with metadata `{empty: true}`.
- `ingest/worker.ts` — `startWorker(pool, config): { stop() }`: `WORKER_CONCURRENCY` slots, idle poll 1 s, claim via §11.1 `UPDATE … WHERE id = (SELECT … status='pending' AND run_after<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`; error: `attempts<5` → `pending`, `run_after=now()+2^attempts s`, `last_error`, else `failed`; on start and every 5 min requeue items `processing` > 10 min; `stop()` stops claiming and awaits in-flight items (graceful SIGTERM/SIGINT). Reinforcement flush stays buffered (E08).
- `routes/ingest.ts` + entrypoint wiring: routes call enqueue; start worker after migrations.
- `test/ingest.integration.test.ts` — vitest against compose `test-db` and `stub-litellm.ts`, covering FR-01..FR-10, FR-23, the NFR-11 secret corpus, and a kill-mid-ingest restart case.

## Verification
```
docker compose --profile test up -d test-db \
&& DATABASE_URL=postgres://recall:recall@localhost:5433/recall_test \
   pnpm --filter @recall/service test
```
Proving output: all new tests pass — one `pending` row per enqueue with no stub LLM call and p95 < 30 ms; SKIP LOCKED double-claim test shows two workers never process the same item; a stub-500 item retries with growing `run_after` and ends `failed` with `last_error` on attempt 5; a worker killed mid-processing, on restart, requeues and completes the item; resolved entities get access bumps; new nodes have embeddings; a contradicting fact invalidates the old one; identical re-sent transcripts are idempotent (FR-10); empty extraction ends `done` `{empty: true}`; no NFR-11 corpus secret appears in any captured stub request or log.

## Out of scope
MCP/HTTP surfaces beyond enqueue routes (E09/E10); reinforcement buffer flush (E08); extraction model choice (`EXTRACT_MODEL` config only); recall pipeline (E06); nightly 30-day done-row purge and LISTEN/NOTIFY optimization.
