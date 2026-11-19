import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { withTenant } from '../src/db/tenant.js';

const MIGRATE = path.resolve(process.cwd(), '..', '..', 'db', 'migrate.mjs');

async function migrate(): Promise<string> {
  const out = execFileSync('node', [MIGRATE], { encoding: 'utf8' });
  return out.trim();
}

// Each table holds a value we can read back to prove the round trip survived.
const VALUES = {
  nodes: { kind: 'entity', label: 'apple', content: 'a red fruit', label_norm: 'apple' },
  edges: { predicate: 'with', sourceId: null as number | null, targetId: null as number | null, strength: 0.5 },
  ingestQueue: { kind: 'remember', client: 'claude-code', payload: { text: 'hi' } },
  sessions: { id: 'sess-123', client: 'hermes', title: 'recall test' },
  recallTrace: { sessionId: null, query: 'what did I read?', cueIds: [1], cueWeights: [1.0], hops: [{ hop: 'associative', from: null, to: null, edge: null, amount: 1 }], recalled: [], params: {}, durationMs: 5, nodeId: null as number | null },
};

const DbIntegration = process.env.DATABASE_URL ? describe : describe.skip;
DbIntegration('db integration', () => {
  beforeAll(async () => {
    // Hermetic reset: drop all app objects + the migration bookkeeping, so the
    // assertions below hold no matter what ran against this database before.
    // Tables first, then the enum type 0001 creates (DROP TABLE does not drop it).
    await pool.query(`
      DROP TABLE IF EXISTS recall_trace, ingest_queue, sessions, edges, nodes, schema_migrations CASCADE;
      DROP TYPE IF EXISTS node_kind
    `);
    expect(await migrate()).toContain('applied 0001_init.sql');
    expect(await migrate()).toContain('no migrations to apply');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('round-trips nodes', async () => {
    const res = await pool.query(
      `INSERT INTO nodes (kind, label, content, label_norm) VALUES ($1, $2, $3, $4) RETURNING kind, label, content, label_norm`,
      [VALUES.nodes.kind, VALUES.nodes.label, VALUES.nodes.content, VALUES.nodes.label_norm],
    );
    expect(res.rows[0]).toEqual(VALUES.nodes);
  });

  it('round-trips edges', async () => {
    // Guarantee two distinct nodes so edges (src<>dst) and dst NOT NULL both hold.
    let ids = (await pool.query('SELECT id FROM nodes ORDER BY id LIMIT 2')).rows.map((r) => Number(r.id));
    if (ids.length < 2) {
      await pool.query(`INSERT INTO nodes (kind, label, content, label_norm) VALUES ($1,$2,$3,$4)`, ['entity','apple-clone','a clone','apple-clone']);
      ids = (await pool.query('SELECT id FROM nodes ORDER BY id LIMIT 2')).rows.map((r) => Number(r.id));
    }
    VALUES.edges.sourceId = ids[0]!;
    VALUES.edges.targetId = ids[1]!;
    const res = await pool.query(
      `INSERT INTO edges (src, dst, predicate, strength) VALUES ($1, $2, $3, $4) RETURNING predicate, strength`,
      [VALUES.edges.sourceId, VALUES.edges.targetId, VALUES.edges.predicate, VALUES.edges.strength],
    );
    expect(res.rows[0].predicate).toBe(VALUES.edges.predicate);
    expect(Number(res.rows[0].strength)).toBeCloseTo(VALUES.edges.strength, 5);
  });

  it('round-trips ingest_queue', async () => {
    const res = await pool.query(
      `INSERT INTO ingest_queue (kind, client, payload) VALUES ($1, $2, $3) RETURNING kind`,
      [VALUES.ingestQueue.kind, VALUES.ingestQueue.client, VALUES.ingestQueue.payload],
    );
    expect(res.rows[0].kind).toBe(VALUES.ingestQueue.kind);
  });

  it('round-trips sessions', async () => {
    const res = await pool.query(
      `INSERT INTO sessions (tenant_id, id, client, title) VALUES ('local', $1, $2, $3) RETURNING client, title`,
      [VALUES.sessions.id, VALUES.sessions.client, VALUES.sessions.title],
    );
    expect(res.rows[0]).toEqual({ client: VALUES.sessions.client, title: VALUES.sessions.title });
  });

  it('round-trips recall_trace', async () => {
    const node = await pool.query('SELECT id FROM nodes LIMIT 1');
    VALUES.recallTrace.nodeId = Number(node.rows[0].id);
    const res = await pool.query(
      `INSERT INTO recall_trace (session_id, client, query, cue_ids, cue_weights, hops, recalled, params, duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING session_id, query`,
      [VALUES.recallTrace.sessionId, 'omp', VALUES.recallTrace.query, VALUES.recallTrace.cueIds, VALUES.recallTrace.cueWeights, JSON.stringify(VALUES.recallTrace.hops), JSON.stringify(VALUES.recallTrace.recalled), JSON.stringify(VALUES.recallTrace.params), VALUES.recallTrace.durationMs],
    );
    expect(res.rows[0].query).toBe(VALUES.recallTrace.query);
  });

  it('exposes the tenant GUC inside withTenant and resets it outside', async () => {
    const inside = await withTenant('tenant-abc', async (client) => {
      const res = await client.query("SELECT current_setting('app.tenant_id', true) AS t");
      return res.rows[0].t;
    });
    expect(inside).toBe('tenant-abc');

    const outside = await pool.query("SELECT current_setting('app.tenant_id', true) AS t");
    expect(outside.rows[0].t).toBe(''); // empty-string GUC default outside the transaction
  });
});
