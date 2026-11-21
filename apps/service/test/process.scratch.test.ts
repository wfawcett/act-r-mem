import { afterAll, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { processItem, type QueueItem } from '../src/ingest/process.js';
import { createClient } from '../src/llm/client.js';
import { startStub } from './stub-litellm.js';
import { setEffectiveParams, loadConfig } from '../src/config.js';

process.env.DATABASE_URL = 'postgres://recall:recall@localhost:5433/recall_test';

const extraction = {
  episodes: [{ key: 'ep', label: 'standup', summary: 'Alice and Bob discussed the deploy', occurred_at: '2026-01-02T10:00:00Z' }],
  entities: [
    { key: 'alice', label: 'Alice', aliases: [] },
    { key: 'bob', label: 'Bob', aliases: [] },
  ],
  facts: [
    { key: 'f1', subject_key: 'alice', statement: 'Alice owns the deploy pipeline', half_life_class: 'identity' as const },
  ],
  edges: [{ from_key: 'alice', to_key: 'bob', predicate: 'works_with', half_life_class: 'default' as const }],
};

const stub = await startStub(768);
const jsonContent = JSON.stringify(extraction);
const queueExtract = (content: unknown) =>
  stub.state.responses.push(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
const queueJudge = () =>
  stub.state.responses.push(JSON.stringify({ choices: [{ message: { content: 'no.' } }] }));

process.chdir('../..'); // loadConfig reads config/params.json from cwd
const config = {
  ...loadConfig({
    DATABASE_URL: 'postgres://recall:recall@localhost:5433/recall_test',
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
const client = createClient(config);

async function reset() {
  await pool.query(`TRUNCATE nodes, edges, ingest_queue, sessions, recall_trace`);
}

await reset();

const item: QueueItem = {
  id: 1,
  tenant_id: 'local',
  kind: 'remember',
  client: 'claude-code',
  session_id: 's1',
  payload: { text: 'Alice and Bob discussed the deploy' },
  status: 'processing',
  attempts: 1,
  run_after: new Date(),
  last_error: null,
  created_at: new Date('2026-01-02T09:00:00Z'),
  started_at: new Date(),
  finished_at: null,
};

it('processes a remember item end to end', async () => {
  queueExtract(extraction);
  queueJudge();
  const status = await processItem(item, { client, config });
  expect(status).toBe('done');
  const nodes = await pool.query<{ id: number; kind: string; label: string; embedding: unknown; access_count: number; occurred_at: string | null; aliases: string[] }>(
    `SELECT id, kind, label, embedding, access_count, occurred_at, aliases FROM nodes ORDER BY id`,
  );
  const kinds = nodes.rows.map((r) => r.kind);
  expect(kinds.filter((k) => k === 'entity').length).toBe(1);
  expect(kinds.filter((k) => k === 'episode').length).toBe(1);
  expect(kinds.filter((k) => k === 'fact').length).toBe(1);
  // every node embedded
  for (const row of nodes.rows) expect(row.embedding).not.toBeNull();
  const edges = await pool.query<{ predicate: string }>(`SELECT predicate FROM edges`);
  expect(edges.rows.map((e) => e.predicate).sort()).toEqual(['about', 'mentioned_in', 'mentioned_in']);
  // entities accessed once at item.created_at
  const alice = nodes.rows.find((r) => r.label === 'Alice')!;
  expect(alice.access_count).toBe(2); // alice label + merged bob label
  expect(alice.aliases).toContain('bob');
});

it('reinforces instead of duplicating on reprocess', async () => {
  queueExtract(extraction);
  queueJudge();
  const before = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM edges`);
  const status = await processItem(item, { client, config });
  expect(status).toBe('done');
  const after = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM edges`);
  // a re-sent remember creates a new episode; its mentioned_in links target
  // existing entity/fact, so exactly 2 new edges (no duplication of old ones)
  expect(after.rows[0]!.n).toBe(String(Number(before.rows[0]!.n) + 2));
  const nodes = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM nodes WHERE kind='entity'`);
  expect(nodes.rows[0]!.n).toBe('1'); // resolution reused, no new entities
});

it('marks structured remember done with zero extract calls', async () => {
  await reset();
  stub.state.chatLog.length = 0;
  const structuredItem: QueueItem = {
    ...item,
    id: 2,
    payload: {
      text: 'structured',
      structured: {
        entities: [{ label: 'Carol' }],
        facts: [{ subject: 'Carol', statement: 'Carol likes tea' }],
        episode: { label: 'tea time', summary: 'Carol had tea' },
        edges: [],
      },
    },
  };
  const status = await processItem(structuredItem, { client, config });
  expect(status).toBe('done');
  const chats = stub.state.chatLog.filter((e: { path: string }) => e.path.endsWith('/chat/completions'));
  expect(chats.length).toBe(0);
  const carol = await pool.query<{ embedding: unknown }>(`SELECT embedding FROM nodes WHERE label='Carol'`);
  expect(carol.rows[0]!.embedding).not.toBeNull();
});

it('handles empty extraction', async () => {
  await reset();
  queueExtract({ episodes: [], entities: [], facts: [], edges: [] });
  const emptyItem: QueueItem = { ...item, id: 3, payload: { text: 'nothing here' } };
  const status = await processItem(emptyItem, { client, config });
  expect(status).toBe('done');
  const nodes = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM nodes`);
  expect(nodes.rows[0]!.n).toBe('0');
});

afterAll(async () => {
  await reset();
  await stub.close();
  await pool.end();
});
