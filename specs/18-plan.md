# Plan: E09 — MCP server (card #18)

Spec: `specs/18-e09-mcp-server.md`. Tool descriptions and §8 shapes verified in `docs/recall-prd.md` §8.1–8.6. Existing symbols verified in tree: `RememberInputSchema`/`enqueueRemember` (`src/ingest/enqueue.ts`), `recall` + `RecallDeps`/`RecallInput`/`RecalledMemory` (`src/recall/pipeline.ts`, `src/recall/deps.ts`), `writeTrace` (`src/recall/trace.ts`), `UseBuffer` (`src/reinforce/buffer.ts`, attached as `app.useBuffer`), `forgetNode` (`src/reinforce/forget.ts`), `createClient` (`src/llm/client.ts`), `buildApp` (`src/routes/ingest.ts`).

Note on spec naming: the spec's `runRecall` is `recall(input: RecallInput, deps: RecallDeps)` in `src/recall/pipeline.ts`. `RecallDeps.db` must be a transaction-capable `PoolClient`, so the MCP layer opens a per-call `BEGIN`/`COMMIT` client from the shared pool; `flushUses` (E08) already handles trace-path edge reinforcement and `used_ids` appends when a use carries `traceId`, so `mark_used` only feeds the buffer.

## 1. Task list

1. Add `@modelcontextprotocol/sdk` to `apps/service/package.json` (single new dependency; no other packages).
DONE: Add `@modelcontextprotocol/sdk` to `apps/service/package.json` (single new dependency; no other packages).
2. DONE: Create `apps/service/src/mcp/tools.ts` — thin per-tool handler functions (`rememberTool`, `recallTool`, `markUsedTool`, `getMemoryTool`, `forgetTool`) plus `ToolValidationError` and `logError(requestId, err)`; zod-validate every input, reuse `RememberInputSchema` from `../ingest/enqueue.js`, throw `ToolValidationError` with the exact §8.6 short messages on validation failure, and open the per-call `PoolClient` transaction for `recallTool` (`BEGIN` → `recall()` → `COMMIT`/`ROLLBACK`).
3. Create `apps/service/src/mcp/server.ts` — factory `createMcpServer(deps, clientName?)` creating one `McpServer` (name `recall`) per session and registering the five tools with the exact §8 description strings and zod schemas; each register handler catches `ToolValidationError` (error result with the message verbatim) and any other throw (`logError(requestId, err)` then error result `"Memory is unavailable right now"`); when `clientName` is present it overrides the input's `client`.
DONE: Create `apps/service/src/mcp/server.ts` — factory `createMcpServer(deps, clientName?)` …; when `clientName` is present it overrides the input's `client`.
4. Create `apps/service/src/mcp/register.ts` — export `registerMcp(app, deps)`; mount `StreamableHTTPServerTransport` in stateful mode at `POST /mcp` (`mcp-session-id` header per SDK), resolve the client name from the initialize request's `clientInfo.name`, require `Authorization: Bearer <token>` when `config.recallToken` is set (401 otherwise), and log tool dispatch with the Fastify request id.
   DONE: Create `apps/service/src/mcp/register.ts` — export `registerMcp(app, deps)`; mount `StreamableHTTPServerTransport` stateful at `POST /mcp`, clientInfo.name override, recallToken bearer gate, request-id logging.
5. Wire it in `apps/service/src/routes/ingest.ts` (`buildApp`) — call `registerMcp(app, { config: opts.config })` after the existing routes; keep E10 hook routes out.
DONE: Wire it in `apps/service/src/routes/ingest.ts` (`buildApp`) — call `registerMcp(app, { config: opts.config })` after the existing routes; keep E10 hook routes out.
6. Add `apps/service/test/mcp.integration.test.ts` — SDK `Client` + `StreamableHTTPClientTransport` against the compose test Postgres (migrations via `db/migrate.mjs`, same pattern as `recall.integration.test.ts`): list tools (exact §8 descriptions), drive all five tools, the error paths (empty text, unknown id get/forget, oversized ids > 50), the internal-error message, and the transport-client-name override.
   DONE: Add `apps/service/test/mcp.integration.test.ts` — SDK Client over StreamableHTTPClientTransport against the compose test Postgres: exact §8 descriptions, all five tools, §8.6 error paths, internal-error message, client-name override.
7. Add the new test file to the `test:integration` script in `apps/service/package.json`.
   DONE: Add the new test file (`test/mcp.integration.test.ts`) to the `test:integration` script in `apps/service/package.json`.

## 2. Types and interfaces

```ts
// apps/service/src/mcp/tools.ts
import type { Pool } from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { RememberInput } from '../ingest/enqueue.js';
import type { RecallResult, RecalledMemory } from '../recall/deps.js';
import type { UseBuffer } from '../reinforce/buffer.js';

export interface McpToolDeps {
  pool: Pool;                          // shared pool; recallTool opens a per-call PoolClient transaction
  config: Config;                      // params snapshot (resultLimit default), contextMaxChars, tenant 'local'
  embed(text: string): Promise<number[]>;   // LiteLLM embed, created in register.ts from config
  useBuffer: Pick<UseBuffer, 'add'>;   // app.useBuffer (FR-19/FR-22 producers)
  log: FastifyBaseLogger;              // request-scoped logger; Fastify attaches the request id
}

export class ToolValidationError extends Error {}   // message returned to the model verbatim (§8.6)

export function logError(requestId: string, err: unknown): void;  // logs with the request id; dispatch layer then returns "Memory is unavailable right now"

export interface RecallToolInput {
  query: string;                       // 1..4000 chars
  cues?: string[];                     // node ids as strings or labels → RecallInput.explicitCues
  limit?: number;                      // 1..25, default params.resultLimit
  session_id?: string;
  client?: string;                     // overridden by the transport's clientInfo.name when present
}

export interface MemoryConnection {
  id: number;
  label: string;
  kind: 'entity' | 'fact' | 'episode';
  predicate: string;
  strength: number;
  dormant: boolean;
}

export async function rememberTool(deps: McpToolDeps, input: RememberInput): Promise<{ queued_id: number }>;
export async function recallTool(deps: McpToolDeps, input: RecallToolInput): Promise<RecallResult>;       // { trace_id, memories, text } — writeTrace called after the result is composed (§8.2)
export async function markUsedTool(deps: McpToolDeps, input: { trace_id?: number; ids: number[] }): Promise<{ accepted: number }>;  // one useBuffer.add({ nodeId, traceId }) per id (1..50 ids)
export async function getMemoryTool(deps: McpToolDeps, input: { id: number }): Promise<RecalledMemory & { connections: MemoryConnection[] }>;  // missing id → ToolValidationError "No memory with id <id>"; one useBuffer.add({ nodeId: id }) (FR-22)
export async function forgetTool(deps: McpToolDeps, input: { id: number; reason?: string }): Promise<{ forgotten: true }>;  // pre-check existence → ToolValidationError "No memory with id <id>"; then forgetNode(pool, id)
```

Zod schemas: `RememberInputSchema` reused from `../ingest/enqueue.js`; the other four defined in `tools.ts`/`server.ts` per §8 — `recall` `{ query: string 1..4000; cues?: string[]; limit?: number 1..25; session_id?: string; client?: string }`, `mark_used` `{ trace_id?: number; ids: number[] 1..50 }`, `get_memory` `{ id: number }`, `forget` `{ id: number; reason?: string }`.

```ts
// apps/service/src/mcp/server.ts
export function createMcpServer(deps: McpToolDeps, requestId: string, clientName?: string): McpServer;
// five registerTool calls; name "recall"; handler catch: ToolValidationError →
// error result(err.message); else logError(requestId, err) → error result("Memory is unavailable right now")

// apps/service/src/mcp/register.ts
export interface McpRegisterDeps {
  config: Config;                      // registerMcp builds the LiteLLM client and reads recallToken from here
}
export function registerMcp(app: FastifyInstance, deps: McpRegisterDeps): Promise<void>;
```

Client-name override detail: `RememberInputSchema.client` is an enum (`claude-code|hermes|omp|manual`); the transport name is applied by re-parsing the input with `client` replaced, falling back to the argument (then `'manual'`) when the transport name is outside the enum, so an unknown client name cannot 400 an otherwise valid `remember`.

## 3. Verification mapping

| Task | Command from spec Verification |
| --- | --- |
| 1 (dependency) | `pnpm --filter @recall/service run build` (typecheck pulls the SDK types) |
| 2–5 (tool handlers, server factory, register, buildApp wiring) | `pnpm --filter @recall/service run build` |
| 6–7 (integration test: tool list with exact descriptions, §8 output shapes, §8.6 error messages, client-name override) | `pnpm --filter @recall/service run test:integration` with `mcp.integration.test.ts` added to the script's file list |
| Manual smoke (not automated): Claude Code `.mcp.json` at `/mcp`, `recall` returns injected text | documented in spec; no command |

## 4. Dependencies

Workspace is pnpm, so the install line is:

```
pnpm --filter @recall/service add @modelcontextprotocol/sdk
```

Only that one package; `zod`, `fastify`, `pg` are already dependencies of `@recall/service`. (npm equivalent if ever needed: `npm install @modelcontextprotocol/sdk --workspace @recall/service`.)

## 5. Out of scope

E10 hook routes (`/api/recall/prefetch`, `/api/ingest/transcript`, `/api/mark-used`, `/api/sessions/end`), E11 client config files, P2 per-tenant token model (FR-41/FR-44), UI routes/auth.
