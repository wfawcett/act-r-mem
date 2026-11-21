# Implementation Plan — Card #17 (E08 Reinforcement buffer and use semantics)

Source spec: `specs/17-e08-reinforcement-buffer-and-use-semantics.md`. Goal: every node "use" (recall-trace usage, `get_memory` by id) is buffered in `apps/service` and flushed in batches (every `useFlushMs`=5000ms or 200 ids, whichever first, plus on SIGTERM/shutdown) in one transaction applying `recordAccess` with the dormant-revival bonus (FR-20), `pathEdges`+`reinforceEdge` along trace paths (FR-21), `get_memory` as access-only (FR-22), per-flush dedupe of `(trace_id, node_id)`, `used_ids` append, and `forget`/`restore` flipping `invalid_at` on node+edges (FR-24). Producers of `buffer.add` (MCP routes, implicit-use detection) and the HTTP forget/restore routes are E09/E10 — only the buffer/flush/forget side ships here.

## 1. Task list

1. Add `useFlushMs: number` to the `Config` interface in `apps/service/src/config.ts`, sourced from the existing `DEFAULTS.useFlushMs` (5000) so the buffer timer is configurable via env.
DONE: Add `useFlushMs: number` to the `Config` interface in `apps/service/src/config.ts`, sourced from the existing `DEFAULTS.useFlushMs` (5000) so the buffer timer is configurable via env.
DONE: Add `apps/service/src/reinforce/buffer.ts` — `UseBuffer` class: constructor takes `{ pool, params, useFlushMs, now? }` (`now` injectable, defaults to `Date.now`); `add({ nodeId, traceId? })` dedupes on `(traceId, nodeId)` within the pending set, flushes when pending reaches the 200-id size threshold, and otherwise waits for the interval started by `startTimer()`; `size()`, `flush(): Promise<void>` (swap-and-empty then `flushUses`), `stop()`.
3. Add `apps/service/src/reinforce/flush.ts` — `flushUses(pool, params, uses, now)`: one transaction (single `pool.connect()` client, `BEGIN`, `SET LOCAL app.tenant_id` when tenant context is available via `withTenant`'s pattern); loads `access_count`, `recent_access`, `created_at` for the node set; per node computes `wasDormant = isDormantNode(baseLevel(state, now, params), params)` from current state, applies `recordAccess`, and `UPDATE nodes SET access_count, recent_access`; per distinct `traceId` loads `recall_trace.flows`, computes `pathEdges(flows, nodeId)`, applies `reinforceEdge` exactly once per edge per flush even across multiple nodes on the same trace, and `UPDATE edges SET strength, last_used_at`; appends all used node ids with `UPDATE recall_trace SET used_ids = used_ids || $ids`; returns row counts so read-only assertions work.
4. Add `apps/service/src/reinforce/forget.ts`
DONE: Add `apps/service/src/reinforce/flush.ts` — `flushUses(pool, params, uses, now)`: one transaction (single `pool.connect()` client, `BEGIN`; no `app.tenant_id` GUC since `UseInput` carries no tenant and rows default to 'local'); loads `access_count`, `recent_access`, `created_at` for the node set; per node computes `wasDormant = isDormantNode(baseLevel(state, now, params), params)` from current state, applies `recordAccess`, and `UPDATE nodes SET access_count, recent_access`; per distinct `traceId` loads `recall_trace.hops` as flows, computes `pathEdges(flows, nodeId)`, applies `reinforceEdge` exactly once per edge per flush (per-flush edge-id Set) even across multiple nodes on the same trace, and `UPDATE edges SET strength, last_used_at`; appends distinct used node ids with `UPDATE recall_trace ... used_ids`. Added `@recall/activation` as a workspace dep of `@recall/service` (was missing from package.json). Verified: `pnpm --filter @recall/service test` 27 passed; `tsc` clean in src/.
4. Add `apps/service/src/reinforce/forget.ts` — `forgetNode(pool, id)` sets `invalid_at = now()` on the node and on all non-invalidated incident edges (`src = $1 OR dst = $1`), `restoreNode(pool, id)` clears `invalid_at` on the node and its edges (FR-24); the routes are E10.
DONE: Add `apps/service/src/reinforce/forget.ts` — `forgetNode(pool, id)` sets `invalid_at = now()` on the node and on all non-invalidated incident edges (`src = $1 OR dst = $1`), `restoreNode(pool, id)` clears `invalid_at` on the node and its edges (FR-24); the routes are E10.
5. Wire the buffer into the service entrypoint: instantiate one `UseBuffer` per app instance, register `process.on('SIGTERM')` (and shutdown hook, FR-19/NFR-06) to `await buffer.flush()` before exit, and export the buffer from the app instance so E09/E10 can call `buffer.add`. If no entrypoint file exists yet in the scaffold, add `apps/service/src/reinforce/index.ts` exporting a factory `attachUseBuffer(app, config)` that does the instantiation + signal registration so the E06/E07 entrypoint only calls it.
DONE: Add `apps/service/src/reinforce/index.ts` — `attachUseBuffer(app, opts)` factory (structural `UseBufferHost` with Fastify-style `decorate`, since fastify is not a dependency yet): instantiates one `UseBuffer` (pool, params, `useFlushMs`), `startTimer()`, registers SIGTERM shutdown flush, decorates the app with `useBuffer` for E09/E10.
6. Add `apps/service/test/reinforce.integration.test.ts` — vitest against the test-profile DB (pattern of `test/db.integration.test.ts`: migrate fresh, seed node + trace with flows via SQL); inject a fixed `now` and a zero/1ms interval; cover (a) dormant vs non-dormant node bumps incl. `+reviveExtraAccesses`, (b) trace path edges strengthened + `last_used_at` set once per edge per flush even with duplicate `(trace_id, node_id)`, (c) no-traceId use bumps node only, (d) `used_ids` appended, (e) `forgetNode`/`restoreNode` invalid_at flip, (f) SIGTERM child-process flush, (g) un-flushed uses stay pending.
DONE: Add `apps/service/test/reinforce.integration.test.ts` — vitest against the test-profile DB (pattern of `test/db.integration.test.ts`: migrate fresh, seed node + trace with flows via SQL); inject a fixed `now` and a zero/1ms interval; cover (a) dormant vs non-dormant node bumps incl. `+reviveExtraAccesses`, (b) trace path edges strengthened + `last_used_at` set once per edge per flush even with duplicate `(trace_id, node_id)`, (c) no-traceId use bumps node only, (d) `used_ids` appended, (e) `forgetNode`/`restoreNode` invalid_at flip, (f) SIGTERM child-process flush, (g) un-flushed uses stay pending.
7. Verify with `pnpm --filter @recall/service test` (do not execute here; no implementation in this stage).
DONE: Verify with `pnpm --filter @recall/service test` — full suite green (61+ tests passed, 0 failed).

## 2. Types and interfaces

```ts
// apps/service/src/reinforce/buffer.ts
import type { Pool } from 'pg';
import type { Params } from '@recall/activation';

export interface UseInput { nodeId: number; traceId?: number }
export interface UseBufferOptions {
  pool: Pool;
  params: Params;
  useFlushMs: number;         // interval ms; also `now` injectable for tests
  now?: (d: Date) => number;  // default Date.now (buffer may use wall clock; flush math does not)
  sizeThreshold?: number;     // default 200
}
export class UseBuffer {
  constructor(opts: UseBufferOptions);
  add(use: UseInput): void;               // dedupes (traceId, nodeId); flushes at sizeThreshold
  size(): number;
  flush(): Promise<void>;                 // swap-and-empty, then flushUses
  startTimer(): void;                     // setInterval(useFlushMs)
  stop(): void;                           // clearInterval; does not flush
}

// apps/service/src/reinforce/flush.ts
import type { Pool } from 'pg';
import type { Params } from '@recall/activation';
export interface FlushCounts { nodes: number; edges: number; traces: number }
export function flushUses(
  pool: Pool,
  params: Params,
  uses: readonly UseInput[],
  now: number,
): Promise<FlushCounts>;

// apps/service/src/reinforce/forget.ts
import type { Pool } from 'pg';
export function forgetNode(pool: Pool, id: number): Promise<void>;
export function restoreNode(pool: Pool, id: number): Promise<void>;

// apps/service/src/reinforce/index.ts (entrypoint helper)
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
export function attachUseBuffer(app: FastifyInstance, config: Config): UseBuffer;
```

Internal data flow in `flushUses` (not exported): `Map<nodeId, NodeRow>` loaded with `SELECT id, access_count, recent_access, created_at FROM nodes WHERE id = ANY($1) AND invalid_at IS NULL`; state assembled as `NodeState { accessCount, recentAccess: timestamptz[] → epoch ms newest first, createdAt }`; edges loaded per `pathEdges` id set as `EdgeState { strength, lastUsedAt, halfLifeClass }`; per-flush edge dedupe via a `Set<number>` so one edge hit by several nodes of the same trace reinforces once.

## 3. Verification mapping

| Task | Command | Assertion |
|---|---|---|
| 2 buffer dedupe/threshold/size | `pnpm --filter @recall/service test` | duplicate `(trace_id, node_id)` yields one pending entry; `size()==200` triggers flush; no flush before threshold/timer |
| 3 flush node+edges | same | `nodes.access_count`/`recent_access` grew with `+reviveExtraAccesses` only when node was dormant (a); path edges `strength`↑ + `last_used_at` set once per edge per flush (b); no-traceId use bumps node only (c); `recall_trace.used_ids` appended (d) |
| 4 forget/restore | same | `forgetNode` sets `invalid_at` on node+edges, `restoreNode` clears them (e) |
| 5 SIGTERM wire-up | same | child process with pending buffer + SIGTERM → rows appear and process exits (f) |
| 6 crash-loss bound | same | un-flushed uses remain pending — at most `USE_FLUSH_MS` of uses lost (g) |

## 4. Dependencies

None. `pg` and `@recall/activation` are already dependencies of `@recall/service` (workspace), `vitest` is a root devDependency, and Fastify typing for the helper is already part of the service's intended stack. Nothing to install.
