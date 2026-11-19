# E05 — Config and LiteLLM client (card #14)

## Goal
When done, the service loads a validated config (`config/params.json` + §16.3 env vars with `RECALL_PARAM_*` overrides, unknown keys rejected at startup), refuses a non-private LiteLLM base URL unless `ALLOW_REMOTE_MODELS=true`, verifies `EMBED_DIM=768` against the live model at startup, and exposes `embed()`, `extract()` (zod-validated, one retry) and `judge()` over OpenAI-compatible HTTP to LiteLLM.

## Approach
Files to create or change:
- `apps/service/package.json` — name `@recall/service`, `"type":"module"`, dependency `zod`; scripts `test`: `vitest run`, `build`: `tsc -p tsconfig.json`. Create if absent (E01 scaffold not yet in this worktree); shared tooling stays at the root.
- `apps/service/tsconfig.json` — extends `../../tsconfig.base.json`, includes `src` and `test`.
- `apps/service/src/config.ts` — zod schemas plus loader:
  - `ParamsSchema` (strict; keys exactly as in `config/params.json`, nested `halfLifeDays`) → `type Params`.
  - `ConfigSchema` for §16.3 env vars; required: `DATABASE_URL`, `BIND_ADDRESS`, `UI_PASSWORD`, `SESSION_SECRET`, `LITELLM_BASE_URL`, `EMBED_MODEL`, `EXTRACT_MODEL`; defaults per the table (`PORT=7420`, `WORKER_CONCURRENCY=2`, …) with `EMBED_DIM` default 768 (pinned per wayfinder #5, matches migration `vector(768)`).
  - `loadConfig(env = process.env): Config` — reads env vars, loads `config/params.json`, applies `RECALL_PARAM_<NAME>` overrides (name uppercased, dots → underscores); throws `ConfigError` on unknown param keys or missing required env vars.
  - NFR-12: rejects a `LITELLM_BASE_URL` host outside loopback/RFC1918/ULA and `.lan`/`.local` hostnames unless `ALLOW_REMOTE_MODELS=true`.
  - `verifyEmbedDim(config): Promise<void>` — calls `embed()` once with a probe string, throws if the vector length ≠ `EMBED_DIM`; called from the service entrypoint at startup.
  - `getParams(): Params` — returns the effective params object for E10's `GET /api/params` (route itself is E10).
- `apps/service/src/llm/client.ts` — OpenAI-compatible HTTP via global `fetch`, all calls take `opts?: { requestId?: string }` and send `metadata: { recall_request_id }` plus `user` in the body so LiteLLM→Langfuse traces carry the request id (NFR-14):
  - `embed(text: string, opts?): Promise<number[]>` — POST `{LITELLM_BASE_URL}/embeddings`, model `EMBED_MODEL`.
  - `extract(text: string, opts?): Promise<Extraction>` — POST `/chat/completions`, model `EXTRACT_MODEL`, temperature 0, §11.3 system prompt verbatim, JSON-schema `response_format` derived from the zod schema; parse content and validate with zod; on failure retry exactly once with the validation error appended to the user message; a second failure throws an error whose message includes the zod issues.
  - `judge(newStatement: string, candidateStatement: string, opts?): Promise<boolean>` — §11.4 yes/no contradiction question to `EXTRACT_MODEL`; parses the first token case-insensitively.
  - `type Extraction` per §11.3 (`episodes`, `entities`, `facts`, `edges`) and `type HalfLifeClass = "identity" | "default" | "incidental"`.
- `apps/service/test/stub-litellm.ts` — in-process node:http stub: `/embeddings` returns a fixed 768-dim vector (configurable length), `/chat/completions` replays queued responses and records request bodies.
- `apps/service/test/llm.integration.test.ts` — vitest; sets env (dummy DB/UI values, `LITELLM_BASE_URL=http://127.0.0.1:<port>/v1`) then: embed returns 768 dims; probe against a 1024-dim stub response makes `verifyEmbedDim` throw; remote base URL refused without and accepted with `ALLOW_REMOTE_MODELS=true`; unknown param key rejected, `RECALL_PARAM_DECAY` override reflected in the effective set; extract against two malformed responses makes exactly one retry whose second request contains the validation error, then fails with the schema error included; captured bodies carry `metadata.recall_request_id`.

## Verification
```
pnpm --filter @recall/service test
```
Proving output: vitest passes all suites — embed returns a 768-dim vector and the dimension probe throws on mismatched length; remote base URL is refused unless `ALLOW_REMOTE_MODELS=true`; an unknown param key is rejected while the `RECALL_PARAM_DECAY` override appears in the effective set; extract makes exactly two chat calls (one retry) and the final error message contains the zod schema error.

## Out of scope
Extraction prompt content tuning (§11.3 ships as written); model choice and registration behind LiteLLM (map ticket #7, ops-side proxy config); wiring the `GET /api/params` route (E10 — this card exposes only the loader); recall pipeline and ingest worker use of these clients (E06/E07).
