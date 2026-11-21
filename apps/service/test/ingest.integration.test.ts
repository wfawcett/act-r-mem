// Task 9 (plan §1/§3 row 9): full integration suite for the ingest pipeline
// against the compose test-db (localhost:5433) + stub-litellm. Covers FR-01/02,
// FR-05, FR-06/07, FR-08, FR-09, FR-10, FR-23, §11.5 empty extraction, SKIP
// LOCKED double-claim, retry/backoff with attempt-5 failure, stuck-item
// requeue, graceful stop(), the NFR-11 redaction corpus, and the
// kill-mid-ingest child-process case.
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

// Worker polls on a 1 s interval and the kill test boots child processes
// (build + two full entrypoint boots); the default is far too tight here.
vi.setConfig({ testTimeout: 60000 });

import { enqueueRemember, enqueueTranscript } from '../src/ingest/enqueue.js';
import { startWorker, type WorkerHandle } from '../src/ingest/worker.js';
import { loadConfig, setEffectiveParams } from '../src/config.js';
import { startStub } from './stub-litellm.js';

const MIGRATE = path.resolve(process.cwd(), '..', '..', 'db', 'migrate.mjs');
const DATABASE_URL = 'postgres://recall:recall@127.0.0.1:5433/recall_test';

const stub = await startStub(768);
const queueExtract = (content: unknown) =>
  stub.state.responses.push(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
const queueJudge = (answer: 'yes' | 'no') =>
  stub.state.responses.push(JSON.stringify({ choices: [{ message: { content: answer } }] }));
const chatCalls = () => stub.state.chatLog.filter((c) => c.path.endsWith('/chat/completions')).length;

process.env.DATABASE_URL = DATABASE_URL;
// pool.ts reads DATABASE_URL at import time — import after setting it.
const { pool } = await import('../src/db/pool.js');
execFileSync('node', [MIGRATE], { encoding: 'utf8' });
// Leftover rows from a previous crashed run (e.g. a killed child worker) sit in
// ingest_queue and get claimed by this run's workers, desyncing the queued stub
// responses. Clear them once before the suite starts.
await pool.query(`TRUNCATE ingest_queue`);

process.chdir('../..'); // loadConfig reads config/params.json from cwd
const baseConfig = loadConfig({
  DATABASE_URL,
  BIND_ADDRESS: '127.0.0.1',
  UI_PASSWORD: 'x',
  SESSION_SECRET: 'x',
  LITELLM_BASE_URL: stub.url,
  EMBED_MODEL: 'stub',
  EXTRACT_MODEL: 'stub',
});
// Small recentAccesses so FR-07 trimming is observable with few accesses.
const config = {
  ...baseConfig,
  params: { ...baseConfig.params, recentAccesses: 2 },
  extractWindowChars: 6000,
  workerConcurrency: 2,
};
setEffectiveParams(config.params);

const ALICE_VECTOR = `[${new Array<number>(768).fill(0.5).join(',')}]`;

async function reset(): Promise<void> {
  await pool.query(`TRUNCATE nodes, edges, ingest_queue, sessions, recall_trace`);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const queueRow = async (id: number) => {
  const { rows } = await pool.query<{
    status: string; attempts: number; run_after: Date; last_error: string | null;
    started_at: Date | null; finished_at: Date | null;
  }>(
    `SELECT status, attempts, run_after, last_error, started_at, finished_at FROM ingest_queue WHERE id = $1`,
    [id],
  );
  return rows[0];
};

async function startWorkerUntil(itemIds: number[], predicate: (r: { status: string }) => boolean) {
  const worker = startWorker(pool, config);
  try {
    await waitFor(async () => {
      const rows = await Promise.all(itemIds.map((id) => queueRow(id)));
      return rows.every((r) => r !== undefined && predicate(r));
    });
  } finally {
    await worker.stop();
  }
}

const countNodes = async (kind?: string): Promise<number> => {
  const { rows } = await pool.query<{ n: string }>(
    kind ? `SELECT count(*)::text AS n FROM nodes WHERE kind = $1` : `SELECT count(*)::text AS n FROM nodes`,
    kind ? [kind] : [],
  );
  return Number(rows[0]?.n ?? 0);
};

const turn = (index: number, role: 'user' | 'assistant', content: string, at: string) => ({ index, role, content, at });

afterEach(async () => {
  stub.state.responses.length = 0;
});

afterAll(async () => {
  await stub.close();
  await pool.end();
});

describe('FR-01/02: enqueue stores exactly one pending row, no LLM traffic', () => {
  it('remember enqueue inserts one pending row with the right shape', async () => {
    await reset();
    const { queued_id } = await enqueueRemember({
      text: 'hello world', occurred_at: '2026-01-01T00:00:00Z', session_id: 's-a', client: 'claude-code',
    });
    const { rows } = await pool.query<{
      kind: string; status: string; client: string; session_id: string | null; payload: Record<string, unknown>;
    }>(`SELECT kind, status, client, session_id, payload FROM ingest_queue WHERE id = $1`, [queued_id]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe('remember');
    expect(row.status).toBe('pending');
    expect(row.client).toBe('claude-code');
    expect(row.session_id).toBe('s-a');
    expect(row.payload).toMatchObject({ text: 'hello world', occurred_at: '2026-01-01T00:00:00Z' });
    // FR-01: nothing reached the LLM at enqueue time.
    expect(chatCalls()).toBe(0);
  });

  it('transcript enqueue inserts one pending row storing { turns }', async () => {
    await reset();
    const { queued_id } = await enqueueTranscript({
      client: 'omp', session_id: 's-t',
      turns: [turn(0, 'user', 'hi', '2026-01-01T00:00:00Z')],
    });
    const { rows } = await pool.query<{ kind: string; status: string; payload: { turns: unknown[] } }>(
      `SELECT kind, status, payload FROM ingest_queue WHERE id = $1`, [queued_id],
    );
    expect(rows[0]?.kind).toBe('transcript');
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.payload.turns).toHaveLength(1);
    expect(chatCalls()).toBe(0);
  });

  it('enqueue p95 latency < 30 ms', async () => {
    await reset();
    const times: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const t0 = performance.now();
      await enqueueRemember({ text: `latency probe ${i}` });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(30);
  });
});

describe('FR-05: structured remember makes zero chat/completions calls', () => {
  it('processes a structured payload without any extract call', async () => {
    await reset();
    const { queued_id } = await enqueueRemember({
      text: 'Alice owns the deploy pipeline',
      structured: {
        entities: [{ label: 'Alice' }],
        facts: [{ subject: 'Alice', statement: 'Alice owns the deploy pipeline', half_life_class: 'identity' }],
        edges: [],
      },
    });
    const before = chatCalls();
    await startWorkerUntil([queued_id], (r) => r.status === 'done');
    expect((await queueRow(queued_id))?.status).toBe('done');
    expect(chatCalls() - before).toBe(0);
    const entities = await countNodes('entity');
    expect(entities).toBe(1);
  });
});

describe('FR-06/07: exact, alias and similarity merge + access bump with trimming', () => {
  const extractionFor = (label: string, key = 'a') => ({
    episodes: [],
    entities: [{ key, label, aliases: [] }],
    facts: [],
    edges: [],
  });

  async function seedAlice(): Promise<number> {
    const { rows } = await pool.query<{ id: string | number }>(
      `INSERT INTO nodes (tenant_id, kind, label, label_norm, embedding, access_count, recent_access)
       VALUES ('local', 'entity', 'Alice', 'alice', $1::vector, 1,
               ARRAY[now() - interval '5 days', now() - interval '2 days']::timestamptz[])
       RETURNING id`,
      [ALICE_VECTOR],
    );
    return Number(rows[0]!.id);
  }

  async function entityState(id: number) {
    const { rows } = await pool.query<{
      id: string | number; access_count: number; recent_access: Date[]; aliases: string[];
    }>(`SELECT id, access_count, recent_access, aliases FROM nodes WHERE id = $1`, [id]);
    return rows[0]!;
  }

  it('merges by exact label_norm, alias, and similarity; records trimmed access', async () => {
    await reset();
    const alice = await seedAlice();

    // 1) exact label_norm: label 'alice' normalizes to the existing label_norm.
    queueExtract(extractionFor('alice'));
    const { queued_id: q1 } = await enqueueRemember({ text: 'alice did a thing' });
    await startWorkerUntil([q1], (r) => r.status === 'done');
    expect(await countNodes('entity')).toBe(1); // merged, no new node
    let state = await entityState(alice);
    expect(state.access_count).toBe(2);
    expect(state.aliases).toHaveLength(0); // exact match adds no alias

    // 2) alias merge: 'Al' shares no label_norm but resolves via similarity,
    //    which adds 'al' as an alias on the existing entity.
    queueExtract(extractionFor('Al'));
    const { queued_id: q2 } = await enqueueRemember({ text: 'Al was promoted' });
    await startWorkerUntil([q2], (r) => r.status === 'done');
    expect(await countNodes('entity')).toBe(1);
    state = await entityState(alice);
    expect(state.aliases).toContain('al');
    expect(state.access_count).toBe(3);

    // 3) similarity merge with a distinct label also resolves and adds an alias.
    queueExtract(extractionFor('Alicia'));
    const { queued_id: q3 } = await enqueueRemember({ text: 'Alicia shipped it' });
    const created = await pool.query<{ created_at: Date }>(`SELECT created_at FROM ingest_queue WHERE id = $1`, [q3]);
    await startWorkerUntil([q3], (r) => r.status === 'done');
    expect(await countNodes('entity')).toBe(1);
    state = await entityState(alice);
    expect(state.aliases).toContain('alicia');

    // FR-07: every match recorded one access at the item's created_at and the
    // list is trimmed to params.recentAccesses (= 2 in this suite).
    expect(state.access_count).toBe(4);
    expect(state.recent_access).toHaveLength(2);
    expect(new Date(state.recent_access[0]!).getTime()).toBe(
      new Date(created.rows[0]!.created_at).getTime(),
    );
  });
});

describe('FR-08: new nodes get non-null embeddings', () => {
  it('entity, episode and fact all end up embedded', async () => {
    await reset();
    queueExtract({
      episodes: [{ key: 'ep', label: 'standup', summary: 'Alice and Bob discussed the deploy' }],
      entities: [{ key: 'alice', label: 'Alice', aliases: [] }],
      facts: [{ key: 'f1', subject_key: 'alice', statement: 'Alice owns the deploy pipeline', half_life_class: 'identity' }],
      edges: [],
    });
    const { queued_id } = await enqueueRemember({ text: 'Alice and Bob discussed the deploy' });
    await startWorkerUntil([queued_id], (r) => r.status === 'done');
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM nodes WHERE kind IN ('entity', 'episode', 'fact') AND embedding IS NOT NULL`,
    );
    expect(Number(rows[0]!.n)).toBe(3);
  });
});

describe('FR-09: contradicting fact supersedes and invalidates', () => {
  it('sets invalid_at/superseded_by on the old fact and kills its edges', async () => {
    await reset();
    queueExtract({
      episodes: [],
      entities: [{ key: 'alice', label: 'Alice', aliases: [] }],
      facts: [{ key: 'f1', subject_key: 'alice', statement: 'Alice owns the deploy pipeline', half_life_class: 'identity' }],
      edges: [],
    });
    const q1 = await enqueueRemember({ text: 'Alice owns the deploy pipeline' });
    await startWorkerUntil([q1.queued_id], (r) => r.status === 'done');
    const fact1 = await pool.query<{ id: string | number }>(`SELECT id FROM nodes WHERE kind = 'fact'`);
    expect(fact1.rows).toHaveLength(1);
    const oldFactId = Number(fact1.rows[0]!.id);

    queueExtract({
      episodes: [],
      entities: [{ key: 'alice', label: 'Alice', aliases: [] }],
      facts: [{ key: 'f2', subject_key: 'alice', statement: 'Alice does not own the deploy pipeline', half_life_class: 'default' }],
      edges: [],
    });
    queueJudge('yes');
    const q2 = await enqueueRemember({ text: 'Alice does not own the deploy pipeline' });
    await startWorkerUntil([q2.queued_id], (r) => r.status === 'done');

    const old = await pool.query<{ invalid_at: Date | null; superseded_by: string | number | null }>(
      `SELECT invalid_at, superseded_by FROM nodes WHERE id = $1`, [oldFactId],
    );
    expect(old.rows[0]?.invalid_at).not.toBeNull();
    expect(Number(old.rows[0]?.superseded_by)).not.toBe(oldFactId);
    expect(old.rows[0]?.superseded_by).not.toBeNull();
    const { rows: deadEdges } = await pool.query(
      `SELECT id FROM edges WHERE (src = $1 OR dst = $1) AND invalid_at IS NOT NULL`, [oldFactId],
    );
    expect(deadEdges.length).toBeGreaterThan(0);
  });
});

describe('FR-10: identical transcript replay creates nothing new', () => {
  const turns = () => [
    turn(0, 'user', 'we shipped the deploy pipeline today', '2026-01-01T10:00:00Z'),
    turn(1, 'assistant', 'noted the deploy pipeline milestone', '2026-01-01T10:00:05Z'),
  ];

  it('re-sending (client, session_id, turns) is a no-op', async () => {
    await reset();
    queueExtract({
      episodes: [{ key: 'ep', label: 'deploy', summary: 'the deploy pipeline shipped' }],
      entities: [{ key: 'dep', label: 'deploy', aliases: [] }],
      facts: [],
      edges: [],
    });
    const req = { client: 'claude-code' as const, session_id: 's-replay', turns: turns() };
    const first = await enqueueTranscript(req);
    await startWorkerUntil([first.queued_id], (r) => r.status === 'done');
    const nodesAfterFirst = await countNodes();

    // Replay: windows whose turns were already ingested are dropped; no second
    // extraction response is even needed.
    const second = await enqueueTranscript(req);
    expect(second.queued_id).not.toBe(first.queued_id);
    await startWorkerUntil([second.queued_id], (r) => r.status === 'done');
    expect(await countNodes()).toBe(nodesAfterFirst);
    expect(await countNodes('episode')).toBe(1);
  });
});

describe('FR-23: implicit use bumps the recalled node access', () => {
  it('assistant turn mentioning a recalled node records an access', async () => {
    await reset();
    queueExtract({
      episodes: [],
      entities: [{ key: 'alice', label: 'Alice', aliases: [] }],
      facts: [],
      edges: [],
    });
    const q1 = await enqueueRemember({ text: 'Alice joined the platform team' });
    await startWorkerUntil([q1.queued_id], (r) => r.status === 'done');
    const alice = await pool.query<{ id: string | number; access_count: number }>(
      `SELECT id, access_count FROM nodes WHERE kind = 'entity' AND label = 'Alice'`,
    );
    const aliceId = Number(alice.rows[0]!.id);
    const before = alice.rows[0]!.access_count;

    // A recall that surfaced Alice, then a transcript where an assistant turn
    // mentions her ⇒ implicit use.
    await pool.query(
      `INSERT INTO recall_trace (tenant_id, session_id, client, at, cue_ids, cue_weights, hops, recalled, used_ids, params, duration_ms)
       VALUES ('local', 's-fr23', 'omp', now() - interval '1 minute', '{}', '{}', '[]'::jsonb,
               $1::jsonb, '{}', '{}'::jsonb, 5)`,
      [JSON.stringify([{ id: aliceId, lane: 'associative', A: 1, B: 1, S: 1 }])],
    );
    queueExtract({
      episodes: [],
      entities: [{ key: 'alice', label: 'Alice', aliases: [] }],
      facts: [],
      edges: [],
    });
    const q2 = await enqueueTranscript({
      client: 'omp', session_id: 's-fr23',
      turns: [
        turn(0, 'user', 'who joined the platform team?', '2026-01-01T10:05:00Z'),
        turn(1, 'assistant', 'Alice joined the platform team', '2026-01-01T10:05:10Z'),
      ],
    });
    await startWorkerUntil([q2.queued_id], (r) => r.status === 'done');
    const after = await pool.query<{ access_count: number }>(`SELECT access_count FROM nodes WHERE id = $1`, [aliceId]);
    expect(after.rows[0]!.access_count).toBe(before + 1);
  });
});

describe('§11.5: empty extraction is done, creating no rows', () => {
  it('{} extraction ⇒ done with zero nodes', async () => {
    await reset();
    queueExtract({ episodes: [], entities: [], facts: [], edges: [] });
    const { queued_id } = await enqueueRemember({ text: 'nothing worth keeping here' });
    await startWorkerUntil([queued_id], (r) => r.status === 'done');
    expect((await queueRow(queued_id))?.finished_at).not.toBeNull();
    expect(await countNodes()).toBe(0);
  });
});

describe('worker mechanics', () => {
  let worker: WorkerHandle | null = null;
  afterEach(async () => {
    worker?.stop();
    worker = null;
    await reset();
  });

  it('SKIP LOCKED: two concurrent claims never return the same item', async () => {
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
      expect(a.rows[0]?.id).not.toBe(b.rows[0]?.id);
    } finally {
      await client1.query('ROLLBACK');
      await client2.query('ROLLBACK');
      client1.release();
      client2.release();
    }
  });

  it('stub 500 ⇒ pending with growing run_after, failed + last_error on attempt 5', async () => {
    // No queued responses → the stub answers /chat/completions with 500.
    const { queued_id } = await enqueueRemember({ text: 'Alice owns the deploy pipeline' });
    worker = startWorker(pool, config);
    await waitFor(async () => {
      const r = await queueRow(queued_id);
      return r?.status === 'pending' && r?.attempts === 1;
    });
    const first = await queueRow(queued_id);
    expect(first?.attempts).toBe(1);
    expect(first?.last_error).not.toBeNull();
    expect(first?.run_after.getTime()).toBeGreaterThan(Date.now() + 1500); // 2^1 s backoff
    await pool.query(
      `UPDATE ingest_queue SET attempts = 4, status = 'pending', run_after = now(), started_at = NULL WHERE id = $1`,
      [queued_id],
    );
    await waitFor(async () => (await queueRow(queued_id))?.status === 'failed');
    const failed = await queueRow(queued_id);
    expect(failed?.attempts).toBe(5);
    expect(failed?.last_error).not.toBeNull();
  });

  it('requeues items stuck processing > 10 min on startup', async () => {
    const stuck = await pool.query<{ id: number }>(
      `INSERT INTO ingest_queue (tenant_id, kind, client, payload, status, started_at, attempts)
       VALUES ('local', 'remember', 'claude-code', $1, 'processing', now() - interval '11 minutes', 3)
       RETURNING id`,
      [JSON.stringify({ text: 'stuck item' })],
    );
    const id = stuck.rows[0]!.id;
    worker = startWorker(pool, config);
    await waitFor(async () => (await queueRow(id))?.status === 'pending');
    expect((await queueRow(id))?.started_at).toBeNull();
  });

  it('stop() resolves after draining an in-flight item', async () => {
    queueExtract({
      episodes: [],
      entities: [{ key: 'alice', label: 'Alice', aliases: [] }],
      facts: [],
      edges: [],
    });
    const { queued_id } = await enqueueRemember({ text: 'Alice owns the deploy pipeline' });
    worker = startWorker(pool, config);
    await worker.stop(); // must resolve, possibly mid-item
    expect(['done', 'pending']).toContain((await queueRow(queued_id))?.status);
    const w2 = startWorker(pool, config);
    await waitFor(async () => (await queueRow(queued_id))?.status === 'done');
    await w2.stop();
  });
});

describe('NFR-11: secret corpus never reaches any LLM request body', () => {
  const SECRETS = [
    '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret.part',
    'sk-proj-abcdefghij1234567890',
    'ghp_0123456789abcdefghijklmnopqrstuvwxyz',
    'AKIAIOSFODNN7EXAMPLE',
    'postgres://admin:s3cret-pw@db.internal:5432/prod',
  ];
  const secretText = `secrets: ${SECRETS.join(' | ')}`;

  it('remember + transcript with seeded secrets leak nothing', async () => {
    await reset();
    queueExtract({ episodes: [], entities: [], facts: [], edges: [] });
    queueExtract({ episodes: [], entities: [], facts: [], edges: [] });
    const q1 = await enqueueRemember({ text: secretText, occurred_at: '2026-01-01T00:00:00Z' });
    const q2 = await enqueueTranscript({
      client: 'claude-code', session_id: 's-nfr11',
      turns: [turn(0, 'user', secretText, '2026-01-01T00:00:00Z')],
    });
    await startWorkerUntil([q1.queued_id, q2.queued_id], (r) => r.status === 'done');
    for (const entry of stub.state.chatLog) {
      for (const secret of SECRETS) {
        expect(entry.body).not.toContain(secret);
      }
    }
    expect(await countNodes()).toBe(0);
  });
});

describe('kill-mid-ingest: SIGKILL between enqueue and completion', () => {
  it('restart finishes the killed item and a never-claimed empty item', async () => {
    execFileSync('pnpm', ['--filter', '@recall/service', 'build'], { cwd: process.cwd(), encoding: 'utf8' });
    await reset();
    const PORT = '17511';

    const spawnChild = () =>
      spawn(process.execPath, ['apps/service/dist/index.js'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL, BIND_ADDRESS: '127.0.0.1', PORT, UI_PASSWORD: 'x', SESSION_SECRET: 'x',
          LITELLM_BASE_URL: stub.url, EMBED_MODEL: 'stub', EXTRACT_MODEL: 'stub',
        },
        stdio: ['ignore', 'inherit', 'inherit'],
      });

    const healthz = () => fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.ok).catch(() => false);
    const waitForUp = async (child: ReturnType<typeof spawn>) => {
      const start = Date.now();
      for (;;) {
        if (await healthz()) return;
        if (Date.now() - start > 20000) throw new Error('child entrypoint never became healthy');
        await new Promise((r) => setTimeout(r, 150));
        if (child.exitCode !== null) throw new Error(`child exited early with code ${child.exitCode}`);
      }
    };
    const exitOf = (child: ReturnType<typeof spawn>) =>
      new Promise<number | null>((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        child.on('exit', (code) => resolve(code));
      });
    // A leaked child keeps polling the shared test-db and breaks every later
    // run; kill both children no matter how the test fails or times out.
    let child: ReturnType<typeof spawn>;
    let child2: ReturnType<typeof spawn>;
    // The killed item's extract call is delayed so the item is reliably
    // observed mid-processing (a fast pipeline could finish before the first
    // DB poll and never be seen as 'processing').
    stub.state.delayMs = 1200;
    try {
      // Enqueue, boot the child, and kill it hard mid-processing window.
      queueExtract({
        episodes: [],
        entities: [{ key: 'alice', label: 'Alice', aliases: [] }],
        facts: [],
        edges: [],
      });
      const killed = await enqueueRemember({ text: 'Alice owns the deploy pipeline' });
      child = spawnChild();
      await waitForUp(child);
      // Deterministic "mid-processing": wait for the worker to claim the item
      // before killing, so the kill cannot race ahead of the first poll.
      await waitFor(async () => (await queueRow(killed.queued_id))?.status === 'processing');
      child.kill('SIGKILL');
      expect(await exitOf(child)).not.toBe(0);
      // Simulate the >10 min stuck window: the restart's startup sweep then
      // requeues the processing item exactly as it would after 10 real minutes.
      await pool.query(
        `UPDATE ingest_queue SET started_at = now() - interval '11 minutes' WHERE id = $1 AND status = 'processing'`,
        [killed.queued_id],
      );

      // While the child is down, enqueue an item that must never be claimed by
      // the dead worker and completes only after the restart.
      queueExtract({ episodes: [], entities: [], facts: [], edges: [] });
      const empty = await enqueueRemember({ text: 'nothing worth keeping here' });

      // Restart responses: the killed item needs a fresh extraction, the empty
      // item needs its '{}' response.
      queueExtract({
        episodes: [],
        entities: [{ key: 'alice', label: 'Alice', aliases: [] }],
        facts: [],
        edges: [],
      });
      queueExtract({ episodes: [], entities: [], facts: [], edges: [] });

      child2 = spawnChild();
      await waitForUp(child2);
      await waitFor(async () => {
        const [a, b] = await Promise.all([queueRow(killed.queued_id), queueRow(empty.queued_id)]);
        return a?.status === 'done' && b?.status === 'done';
      }, 30000);
      expect(await countNodes('entity')).toBe(1);
      child2.kill('SIGTERM');
      expect(await exitOf(child2)).toBe(0);
    } finally {
      stub.state.delayMs = 0;
      if (child !== undefined && child.exitCode === null) child.kill('SIGKILL');
      if (child2 !== undefined && child2.exitCode === null) child2.kill('SIGKILL');
    }
  });
});
