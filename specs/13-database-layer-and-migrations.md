# E04 — Database layer and migrations (card #13)

## Goal
When done, the service boots against a fresh Postgres by auto-applying the phase-1 schema in order, exposes a capped connection pool plus a per-transaction tenant helper, and re-running migrations is a no-op.

## Approach
Files to create or change:
- `db/migrations/0001_init.sql` — PRD §6.1 DDL verbatim except `embedding vector(768)` (corrected EMBED_DIM). Contains `CREATE EXTENSION IF NOT EXISTS vector`, the `node_kind` enum, and all six tables (`nodes`, `edges`, `ingest_queue`, `sessions`, `recall_trace`, `schema_migrations`) with every index incl. the HNSW cosine index on `nodes.embedding`.
- `db/migrate.mjs` — plain Node ESM runner using `pg`. Reads `db/migrations/*.sql`, sorts by numeric prefix, ensures `schema_migrations` exists, applies only the smallest unapplied file inside a transaction and records it; throws if the next file's number ≠ last applied + 1 or a filename does not match `NNNN_*.sql`. Idempotent: a re-run applies nothing.
- `apps/service/package.json` — name `@recall/service`, `"type":"module"`, dependency `pg`; script `test:integration`: `vitest run test/db.integration.test.ts`. (Builds on the E01 service scaffold; create if absent.)
- `apps/service/src/db/pool.ts` — `export const pool = new Pool({ max: 10 })` from `pg`.
- `apps/service/src/db/tenant.ts` — `export async function withTenant<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T>`; takes one client, begins a transaction, runs `SELECT set_config('app.tenant_id', $1, true)` (transaction-local GUC), awaits `fn(client)`, then commits or rolls back.
- `apps/service/test/db.integration.test.ts` — vitest integration test against compose `test-db`: fresh migrate → re-migrate no-op → round-trip insert/select per table via the pool and `withTenant`.
- `docker-compose.yml` — add `ports: ["5433:5432"]` to `test-db`; set the service container entrypoint/command to run `node db/migrate.mjs` then start the server (migrations at service start).

## Verification
```
docker compose --profile test up -d test-db \
  && DATABASE_URL=postgres://recall:recall@localhost:5433/recall_test pnpm --filter @recall/service test:integration
```
Proving output: vitest passes; the runner logs `applied 0001_init.sql` on the first run and `no migrations to apply` on the re-run (idempotent no-op); round-trip insert/select succeeds for all six tables.

## Out of scope
Phase-2 tables (`tenants`, `api_tokens`) and RLS policies (§6.2); any repository/query logic beyond the pool + tenant helper; embedding/LLM wiring.
