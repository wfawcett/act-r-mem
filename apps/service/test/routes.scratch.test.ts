// Task 8 scoped verification (plan §3 row 8): the route POST returns
// { queued_id } with exactly one ingest_queue row, invalid body ⇒ 400 with no
// row, and the compiled entrypoint (dist/index.js) boots via a child process —
// migrations, listening, worker start and SIGTERM shutdown all exercised.
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { startStub } from './stub-litellm.js';

const MIGRATE = path.resolve(process.cwd(), '..', '..', 'db', 'migrate.mjs');
const DATABASE_URL = 'postgres://recall:recall@127.0.0.1:5433/recall_test';

const stub = await startStub(768);

process.env.DATABASE_URL = DATABASE_URL;
// pool.ts reads DATABASE_URL at import time — import after setting it.
const { pool } = await import('../src/db/pool.js');
const { buildApp } = await import('../src/routes/ingest.js');
const { loadConfig, setEffectiveParams } = await import('../src/config.js');
execFileSync('node', [MIGRATE], { encoding: 'utf8' });

process.chdir('../..'); // loadConfig reads config/params.json from cwd
const config = loadConfig({
  DATABASE_URL,
  BIND_ADDRESS: '127.0.0.1',
  UI_PASSWORD: 'x',
  SESSION_SECRET: 'x',
  LITELLM_BASE_URL: stub.url,
  EMBED_MODEL: 'stub',
  EXTRACT_MODEL: 'stub',
  PORT: '17499',
});
setEffectiveParams(config.params);

const app = await buildApp({ config });
await app.listen({ port: 17449, host: '127.0.0.1' });

async function countRows(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ingest_queue`);
  return Number(rows[0].n);
}

const validBody = {
  client: 'omp',
  session_id: 'sess-routes',
  turns: [{ index: 0, role: 'user', content: 'remember Alice', at: '2026-01-01T00:00:00Z' }],
};

it('POST /api/ingest/transcript returns { queued_id } and inserts one pending row', async () => {
  const before = await countRows();
  const res = await app.inject({ method: 'POST', url: '/api/ingest/transcript', payload: validBody });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { queued_id: number };
  expect(Number.isInteger(body.queued_id)).toBe(true);
  const { rows } = await pool.query<{ id: number; status: string; kind: string }>(
    `SELECT id, status, kind FROM ingest_queue WHERE id = $1`,
    [body.queued_id],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('pending');
  expect(rows[0].kind).toBe('transcript');
  expect((await countRows()) - before).toBe(1);
});

it('invalid body ⇒ 400 and no row inserted', async () => {
  const before = await countRows();
  const res = await app.inject({ method: 'POST', url: '/api/ingest/transcript', payload: { client: 'omp', turns: [] } });
  expect(res.statusCode).toBe(400);
  expect(await countRows()).toBe(before);
});

it('GET /healthz responds ok', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  expect(res.statusCode).toBe(200);
});

it('compiled entrypoint boots: migrate + listen + worker + SIGTERM stop', async () => {
  await pool.query(`TRUNCATE ingest_queue`);
  const child = spawn(process.execPath, ['apps/service/dist/index.js'], {
    cwd: process.cwd(), // repo root: loadConfig reads config/params.json from here
    env: {
      ...process.env,
      DATABASE_URL,
      BIND_ADDRESS: '127.0.0.1',
      PORT: '17499',
      UI_PASSWORD: 'x',
      SESSION_SECRET: 'x',
      LITELLM_BASE_URL: stub.url,
      EMBED_MODEL: 'stub',
      EXTRACT_MODEL: 'stub',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const waitFor = async (fn: () => Promise<boolean>, ms = 15000) => {
    const start = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - start > ms) throw new Error('timeout waiting for entrypoint');
      await new Promise((r) => setTimeout(r, 150));
      if (child.exitCode !== null) throw new Error(`entrypoint exited early with code ${child.exitCode}`);
    }
  };
  const up = () => fetch('http://127.0.0.1:17499/healthz').then((r) => r.ok).catch(() => false);
  await waitFor(up);

  const res = await fetch('http://127.0.0.1:17499/api/ingest/transcript', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validBody),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { queued_id: number };
  const { rows } = await pool.query<{ status: string }>(`SELECT status FROM ingest_queue WHERE id = $1`, [body.queued_id]);
  expect(rows).toHaveLength(1);

  // SIGTERM ⇒ graceful stop: worker drains, server closes, process exits 0.
  child.kill('SIGTERM');
  const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
  expect(code).toBe(0);
  await new Promise((r) => setTimeout(r, 300));
});

afterAll(async () => {
  await app.close();
  await stub.close();
  await pool.end();
});
