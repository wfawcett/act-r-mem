# Implementation Plan — Card #13 (E04 Database layer and migrations)

Source spec: `specs/13-database-layer-and-migrations.md`. Goal: the service boots against a fresh Postgres by auto-applying the phase-1 schema in order, exposes a capped connection pool plus a per-transaction tenant helper, and re-running migrations is a no-op. Phase-2 tables (§6.2) and RLS are out of scope. All tasks run in the E01 service scaffold (`apps/service` — create if absent).

## 1. Task list

1. Add `db/migrations/0001_init.sql` with the PRD §6.1 DDL verbatim except `embedding vector(768)` (corrected EMBED_DIM): `CREATE EXTENSION IF NOT EXISTS vector`, the `node_kind` enum, all six tables (`nodes`, `edges`, `ingest_queue`, `sessions`, `recall_trace`, `schema_migrations`) and every index including the HNSW cosine index on `nodes.embedding`. DONE: file written per PRD §6.1 with vector(768).
2. Add `db/migrate.mjs` — plain Node ESM runner using `pg`: reads `db/migrations/*.sql`, validates each filename against `NNNN_*.sql`, sorts by numeric prefix, ensures `schema_migrations` exists, then inside one transaction applies the smallest unapplied file (throwing if its number ≠ last applied + 1) and records it; logs `applied <file>` or `no migrations to apply`; idempotent. DONE: runner implemented with DATABASE_URL env var.
3. Add `apps/service/package.json` (`@recall/service`, `"type": "module"`, dependency `pg`, script `test:integration: vitest run test/db.integration.test.ts`) plus the minimal scaffold (`src/`, tsconfig) if absent. DONE: scaffold + package.json with pg dependency and test:integration script.
4. Add `apps/service/src/db/pool.ts` — `export const pool = new Pool({ max: 10 })` reading `DATABASE_URL`. DONE: pool.ts with max 10.
5. Add `apps/service/src/db/tenant.ts` — `withTenant` transaction helper per the exact signature below, running `SELECT set_config('app.tenant_id', $1, true)` after `BEGIN`. DONE: tenant.ts implemented with commit/rollback in finally.
6. Add `apps/service/test/db.integration.test.ts` (vitest, against compose `test-db` on localhost:5433): fresh migrate → re-migrate no-op (`no migrations to apply`) → round-trip insert/select for all six tables via `pool` and `withTenant`, asserting the transaction-local GUC is visible inside and reset outside. DONE: integration test covers migrate idempotence + 6-table round trips.
7. Update `docker-compose.yml`: add `ports: ["5433:5432"]` to `test-db`; set the `db` service container command to run `node db/migrate.mjs` then start the server (migrations at service start). DONE: compose updated with 5433 mapping and migrate-then-start entrypoint.
8. Verify: `docker compose --profile test up -d test-db && DATABASE_URL=postgres://recall:recall@localhost:5433/recall_test pnpm --filter @recall/service test:integration` (do not execute here).

## 2. Types and interfaces

```ts
// apps/service/src/db/pool.ts
import { Pool } from 'pg';
export const pool: Pool = new Pool({ max: 10, connectionString: process.env.DATABASE_URL });
```

```ts
// apps/service/src/db/tenant.ts
import type { PoolClient } from 'pg';
export async function withTenant<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T>;
```

Semantics: takes one `PoolClient` from `pool` (caller supplies it so the client can be reused/released by the caller), `BEGIN`s a transaction, runs `SELECT set_config('app.tenant_id', $1, true)` (transaction-local GUC), awaits `fn(client)`, then `COMMIT`s; on error `ROLLBACK`s and rethrows. The runner is a `.mjs` module, not TS — it uses plain `pg` (`new Client({ connectionString: process.env.DATABASE_URL })`) and `fs.readdirSync`.

## 3. Verification mapping

| Task | Verification command that exercises it |
| --- | --- |
| Task 1 (DDL) | Task 8 command: fresh migrate applies `0001_init.sql` against pgvector/pg17 without error. |
| Task 2 (migrate.mjs) | Task 8 command: first run logs `applied 0001_init.sql`, re-run logs `no migrations to apply` (idempotence). |
| Task 3 (scaffold + package.json) | `pnpm --filter @recall/service test:integration` resolves the script and vitest. |
| Task 4 (pool) | Integration test round-trips through `pool.query`. |
| Task 5 (withTenant) | Integration test inserts via `withTenant` and reads `current_setting('app.tenant_id', true)` inside the transaction. |
| Task 6 (integration test) | Task 8 command: vitest passes all six-table round trips. |
| Task 7 (compose) | `docker compose --profile test up -d test-db` exposes localhost:5433. |

Verification step from spec: *"docker compose --profile test up -d test-db && DATABASE_URL=postgres://recall:recall@localhost:5433/recall_test pnpm --filter @recall/service test:integration" — vitest passes; runner logs `applied 0001_init.sql` then `no migrations to apply`; round-trip insert/select succeeds for all six tables.*

## 4. Dependencies

```
pnpm --filter @recall/service add pg
pnpm --filter @recall/service add -D vitest @types/pg
```

(vitest may already resolve from the workspace root devDependency; keep `pg` as the only runtime dependency of `@recall/service`. Postgres itself comes from the existing `pgvector/pgvector:pg17` compose image — no new images.)
