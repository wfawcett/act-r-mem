// Task 7 scoped verification (plan §3 row 7): worker claims, retry/backoff and
// attempt-5 failure, stuck-'processing' requeue, SKIP LOCKED double-claim, and
// stop() draining. Runs against compose test-db + stub-litellm.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { startStub } from './stub-litellm.js';

process.env.DATABASE_URL = 'postgres://recall:recall@127.0.0.1:5433/recall_test';
// pool.ts reads DATABASE_URL at import time — import src modules after setting it.
const { pool } = await import('../src/db/pool.js');
const { startWorker } = await import('../src/ingest/worker.js');
const { enqueueRemember } = await import('../src/ingest/enqueue.js');
const { loadConfig, setEffectiveParams } = await import('../src/config.js');

const MIGRATE = path.resolve(process.cwd(), '..', '..', 'db', 'migrate.mjs');

const extraction = {
  episodes: [],
  entities: [{ key: 'alice', label: 'Alice', aliases: [] }],
  facts: [{ key: 'f1', subject_key: 'alice', statement: 'Alice owns the deploy pipeline', half_life_class: 'default' as const }],
  edges: [],
};

const stub = await startStub(768);
const queueExtract = (content: unknown) =>
  stub.state.responses.push(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));

execFileSync('node', [MIGRATE], { encoding: 'utf8' });

process.chdir('../..'); // loadConfig reads config/params.json from cwd
const config = {
  ...loadConfig({
    DATABASE_URL: 'postgres://recall:recall@127.0.0.1:5433/recall_test',
    BIND_ADDRESS: '127.0.0.1',
    UI_PASSWORD: 'x',
    SESSION_SECRET: 'x',
    LITELLM_BASE_URL: stub.url,
    EMBED_MODEL: 'stub',
    EXTRACT_MODEL: 'stub',
  }),
  extractWindowChars: 6000,
  workerConcurrency: 2,
};
setEffectiveParams(config.params);

async function reset() {
  await pool.query(`TRUNCATE nodes, edges, ingest_queue, sessions, recall_trace`);
}
await reset();

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const row = async (id: number) => {
  const { rows } = await pool.query<{
    status: string;
    attempts: number;
    run_after: Date;
    last_error: string | null;
    started_at: Date | null;
    finished_at: Date | null;
  }>(`SELECT status, attempts, run_after, last_error, started_at, finished_at FROM ingest_queue WHERE id = $1`, [id]);
  return rows[0];
};

let worker: ReturnType<typeof startWorker> | null = null;
afterAll(async () => {
  worker?.stop();
  await stub.close();
  await pool.end();
});

it('claims a pending item and processes it to done', async () => {
  queueExtract(extraction);
  const { queued_id } = await enqueueRemember({ text: 'Alice owns the deploy pipeline' });
  worker = startWorker(pool, config);
  await waitFor(async () => (await row(queued_id))?.status === 'done');
  const r = await row(queued_id);
  expect(r?.finished_at).not.toBeNull();
  const nodes = await pool.query(`SELECT label FROM nodes WHERE kind = 'entity'`);
  expect(nodes.rows.map((n: { label: string }) => n.label)).toContain('Alice');
});

it('retries a failing item with growing run_after and fails on attempt 5', async () => {
  worker?.stop(); // take the worker down so we control each claim
  await reset();
  const { queued_id } = await enqueueRemember({ text: 'Alice owns the deploy pipeline' });
  // No queued responses → the stub answers /chat/completions with 500.
  worker = startWorker(pool, config);
  await waitFor(async () => (await row(queued_id))?.status === 'pending' && (await row(queued_id))?.attempts === 1);
  const afterFirst = await row(queued_id);
  expect(afterFirst?.attempts).toBe(1);
  expect(afterFirst?.last_error).not.toBeNull();
  expect(afterFirst?.run_after.getTime()).toBeGreaterThan(Date.now() + 1500); // 2^1 s backoff
  // Fast-forward to the last attempt: claim then bumps attempts to 5.
  await pool.query(
    `UPDATE ingest_queue SET attempts = 4, status = 'pending', run_after = now(), started_at = NULL WHERE id = $1`,
    [queued_id],
  );
  await waitFor(async () => (await row(queued_id))?.status === 'failed');
  const failed = await row(queued_id);
  expect(failed?.attempts).toBe(5);
  expect(failed?.last_error).not.toBeNull();
  expect(failed?.finished_at).not.toBeNull();
});

it('requeues items stuck processing > 10 min on startup', async () => {
  worker?.stop();
  await reset();
  const stuck = await pool.query<{ id: number }>(
    `INSERT INTO ingest_queue (tenant_id, kind, client, payload, status, started_at, attempts)
     VALUES ('local', 'remember', 'claude-code', $1, 'processing', now() - interval '11 minutes', 3)
     RETURNING id`,
    [JSON.stringify({ text: 'stuck item' })],
  );
  const id = stuck.rows[0]!.id;
  worker = startWorker(pool, config);
  await waitFor(async () => (await row(id))?.status === 'pending');
  const r = await row(id);
  expect(r?.started_at).toBeNull();
});

it('SKIP LOCKED: two concurrent claims never return the same item', async () => {
  worker?.stop();
  await reset();
  await pool.query(
    `INSERT INTO ingest_queue (tenant_id, kind, client, payload) VALUES ('local','remember','claude-code','{"text":"one"}'),
     ('local','remember','claude-code','{"text":"two"}')`,
  );
  const claim = (c: PoolClient) =>
    c.query<{ id: number }>(`UPDATE ingest_queue SET status='processing', started_at=now(), attempts=attempts+1
      WHERE id = (SELECT id FROM ingest_queue WHERE status='pending' AND run_after <= now()
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id`);
  const client1 = await pool.connect();
  const client2 = await pool.connect();
  try {
    await client1.query('BEGIN');
    await client2.query('BEGIN');
    const [a, b] = await Promise.all([claim(client1), claim(client2)]);
    const idA = a.rows[0]?.id;
    const idB = b.rows[0]?.id;
    // Two concurrent claims on two items: distinct ids (one may miss if a claim
    // raced, but never the same item).
    expect(idA).not.toBe(idB);
  } finally {
    await client1.query('ROLLBACK');
    await client2.query('ROLLBACK');
    client1.release();
    client2.release();
  }
});

it('stop() resolves after draining and leaves no stuck rows', async () => {
  worker?.stop();
  await reset();
  queueExtract(extraction);
  const { queued_id } = await enqueueRemember({ text: 'Alice owns the deploy pipeline' });
  worker = startWorker(pool, config);
  await worker.stop(); // may drain the item mid-flight; must resolve
  const r = await row(queued_id);
  expect(['done', 'pending']).toContain(r?.status);
  // Whatever stop() left, a fresh worker finishes it.
  const w2 = startWorker(pool, config);
  await waitFor(async () => (await row(queued_id))?.status === 'done');
  await w2.stop();
});
