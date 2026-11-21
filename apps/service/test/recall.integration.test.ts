// E06 recall pipeline integration tests (card #15, plan task 7).
// Runs against the compose `test-db` (DATABASE_URL, port 5433); migrations are
// applied via db/migrate.mjs before a per-suite fixture graph is seeded in the
// 'recall-test' tenant. Embeddings are a deterministic stub vector set: one-hot
// 768-dim vectors, so cosine similarity is 1.0 for a matching key and 0.0 for
// orthogonal ones; `blend` builds a unit vector with a chosen cosine to a base.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { pool } from '../src/db/pool.js';
import type { Params } from '../src/config.js';
import type { RecallDeps, RecallInput } from '../src/recall/deps.js';
import { recall } from '../src/recall/pipeline.js';
import { runPrefetch } from '../src/recall/prefetch.js';

const TENANT = 'recall-test';
const DIM = 768;
const MIGRATE = path.resolve(process.cwd(), '..', '..', 'db', 'migrate.mjs');

const DAY = 86_400_000;
const NOW = Date.now();
const daysAgo = (d: number): number => Math.floor((NOW - d * DAY) / 1000); // epoch seconds

const PARAMS: Params = {
  decay: 0.5, recentAccesses: 10, minAgeDays: 0.01, tau: -1.0, noiseScale: 0.35, dormantP: 0.2,
  edgeFloor: 0.001, edgeInitial: 1.0, edgeGain: 0.2,
  halfLifeDays: { identity: 180, default: 30, incidental: 7 },
  hops: 3, damping: 0.7, pruneEpsilon: 0.0001, maxExpanded: 2000,
  seedK: 8, seedMinSim: 0.35, spreadWeight: 10, minSpread: 0.02,
  recallThreshold: 0.5, resultLimit: 10, directMinSim: 0.8, reviveExtraAccesses: 2,
};

function oneHot(i: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[i] = 1;
  return v;
}

// Unit vector with cosine `cos` to oneHot(i), orthogonal component on axis j.
function blend(i: number, j: number, cos: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[i] = cos;
  v[j] = Math.sqrt(1 - cos * cos);
  return v;
}

const vecLiteral = (v: number[]): string => '[' + v.join(',') + ']';

// Embedding stub: exact map hits return the fixture vector; anything else hashes
// into axis range [100, 700) — orthogonal to every fixture axis (10..99).
const VECTORS = new Map<string, number[]>([
  ['Alice', oneHot(10)],
  ['Bob', oneHot(20)],
  ['fact-1', oneHot(30)],
  ['ep-morning', oneHot(40)],
  ['below-threshold-q', blend(30, 98, 0.79)], // cosine 0.79 to fact-1, <0.8 to every fixture fact
]);

interface EmbedCounter { n: number }

function makeEmbed(counter?: EmbedCounter): (text: string) => Promise<number[]> {
  return async (text: string) => {
    if (counter) counter.n += 1;
    const hit = VECTORS.get(text);
    if (hit) return hit;
    const axis = 100 + ([...text].reduce((a, c) => a + c.charCodeAt(0), 0) % 600);
    return oneHot(axis);
  };
}

function makeDeps(db: PoolClient, embed: (text: string) => Promise<number[]>, over: Partial<RecallDeps> = {}): RecallDeps {
  return { db, embed, params: PARAMS, ...over };
}

function makeInput(over: Partial<RecallInput>): RecallInput {
  return { tenant: TENANT, sessionId: 's-default', query: 'q', explicitCues: [], ...over };
}

// --- fixture -----------------------------------------------------------------

const FIXTURE_TENANTS = ['recall-test', 'local'] as const; // prefetch serves the default 'local' tenant
const tenantIds = new Map<string, Map<string, number>>();
const id = (key: string, tenant: string = TENANT): number => tenantIds.get(tenant)!.get(key)!;

interface SeedNode {
  key: string; kind: 'entity' | 'fact' | 'episode'; label: string;
  content: string | null; aliases: string[]; vec: number[];
  createdDaysAgo: number; accessedDaysAgo: number; occurredDaysAgo?: number;
}

const SEED_NODES: SeedNode[] = [
  { key: 'Alice', kind: 'entity', label: 'Alice', content: null, aliases: [], vec: oneHot(10), createdDaysAgo: 0.01, accessedDaysAgo: 0.01 },
  { key: 'Bob', kind: 'entity', label: 'Bob', content: null, aliases: ['Bobby'], vec: oneHot(20), createdDaysAgo: 0.01, accessedDaysAgo: 0.01 },
  { key: 'fact-1', kind: 'fact', label: 'fact-1', content: 'Alice likes tea', aliases: [], vec: oneHot(30), createdDaysAgo: 0.01, accessedDaysAgo: 0.01 },
  { key: 'fact-2', kind: 'fact', label: 'fact-2', content: 'Alice enjoys tea', aliases: [], vec: blend(30, 99, 0.9), createdDaysAgo: 0.01, accessedDaysAgo: 0.01 },
  { key: 'fact-3', kind: 'fact', label: 'fact-3', content: 'Alice drinks tea', aliases: [], vec: blend(30, 99, 0.5), createdDaysAgo: 0.01, accessedDaysAgo: 0.01 },
  { key: 'ep-morning', kind: 'episode', label: 'ep-morning', content: 'Morning walk around the park', aliases: [], vec: oneHot(40), createdDaysAgo: 1, accessedDaysAgo: 1, occurredDaysAgo: 1 },
  { key: 'OldFriend', kind: 'entity', label: 'OldFriend', content: null, aliases: [], vec: oneHot(50), createdDaysAgo: 400, accessedDaysAgo: 400 },
];

async function seedFixture(client: PoolClient, tenant: string): Promise<void> {
  const ids = new Map<string, number>();
  tenantIds.set(tenant, ids);
  for (const n of SEED_NODES) {
    const occurred = n.occurredDaysAgo === undefined ? 'NULL' : `to_timestamp(${daysAgo(n.occurredDaysAgo)})`;
    const res = await client.query<{ id: string }>(
      `INSERT INTO nodes
         (tenant_id, kind, label, content, label_norm, aliases, embedding,
          occurred_at, created_at, access_count, recent_access)
       VALUES ($1, $2, $3, $4, $5, $6, $7::vector,
               ${occurred}, to_timestamp(${daysAgo(n.createdDaysAgo)}), 1, ARRAY[to_timestamp(${daysAgo(n.accessedDaysAgo)})])
       RETURNING id`,
      [tenant, n.kind, n.label, n.content, n.label.toLowerCase(), n.aliases, vecLiteral(n.vec)],
    );
    ids.set(n.key, Number(res.rows[0]!.id));
  }
  await client.query(
    `INSERT INTO edges (tenant_id, src, dst, predicate, half_life_class, strength, last_used_at) VALUES
       ($1, $2, $3, 'about', 'identity', 1.0, to_timestamp(${daysAgo(0.01)})),
       ($1, $2, $4, 'with', 'default', 1.0, to_timestamp(${daysAgo(0.01)})),
       ($1, $5, $6, 'about', 'incidental', 0.001, to_timestamp(${daysAgo(400)}))`,
    [tenant, id('Alice', tenant), id('fact-1', tenant), id('Bob', tenant), id('ep-morning', tenant), id('OldFriend', tenant)],
  );
}

// --- suite -------------------------------------------------------------------

const RecallDbIntegration = process.env.DATABASE_URL ? describe : describe.skip;
RecallDbIntegration('recall pipeline integration', () => {
  let client: PoolClient;

  beforeAll(async () => {
    execFileSync('node', [MIGRATE], { encoding: 'utf8' });
    client = await pool.connect();
    await client.query('BEGIN');
    // Hermetic per-tenant reset, then seed the fixture graph in both tenants
    // (prefetch serves the default 'local' tenant, the rest use 'recall-test').
    for (const t of FIXTURE_TENANTS) {
      await client.query('DELETE FROM recall_trace WHERE tenant_id = $1', [t]);
      await client.query('DELETE FROM sessions WHERE tenant_id = $1', [t]);
      await client.query('DELETE FROM edges WHERE tenant_id = $1', [t]);
      await client.query('DELETE FROM nodes WHERE tenant_id = $1', [t]);
      await seedFixture(client, t);
    }
  });

  afterAll(async () => {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  });

  it('FR-11: response rows match the §8 shape and text lists ids', async () => {
    const result = await recall(makeInput({ query: 'Alice' }), makeDeps(client, makeEmbed()));
    expect(result.memories.length).toBeGreaterThan(0);
    for (const m of result.memories) {
      expect(Object.keys(m).sort()).toEqual(
        ['activation', 'base_level', 'content', 'id', 'kind', 'label', 'lane', 'occurred_at', 'spread', 'via'],
      );
      expect(['associative', 'exposure', 'direct']).toContain(m.lane);
      expect(typeof m.base_level).toBe('number');
      if (m.lane === 'associative') {
        expect(m.activation).not.toBeNull();
        expect(m.spread).not.toBeNull();
        expect(m.via).toBeNull();
      } else {
        expect(m.activation).toBeNull();
        expect(m.spread).toBeNull();
      }
      expect(result.text).toContain(`[${m.id}]`);
    }
    // Associative rows are ranked by activation desc.
    const assoc = result.memories.filter((m) => m.lane === 'associative').map((m) => m.activation as number);
    expect([...assoc].sort((a, b) => b - a)).toEqual(assoc);
    expect(result.trace_id).toBeDefined();
  });

  it('FR-12: explicit id and label cues merge at weight 1.0 in the trace row', async () => {
    const result = await recall(
      makeInput({
        sessionId: 's-fr12',
        query: 'nothing-matches-this-axis',
        explicitCues: [
          { id: id('Alice') },
          { label: 'Bob' },
          { label: 'Bobby' }, // alias resolves to the same node — merges
          { label: 'ghost-label-nope' }, // unresolvable — ignored
        ],
      }),
      makeDeps(client, makeEmbed()),
    );
    expect(result.trace_id).toBeDefined();
    const trace = await client.query<{ cue_ids: string[]; cue_weights: number[] }>(
      'SELECT cue_ids, cue_weights FROM recall_trace WHERE id = $1',
      [result.trace_id],
    );
    const cueIds = trace.rows[0]!.cue_ids.map(Number);
    expect(cueIds).toContain(id('Alice'));
    expect(cueIds).toContain(id('Bob'));
    expect(cueIds).toHaveLength(2); // alias merged; ghost dropped
    expect(trace.rows[0]!.cue_weights).toHaveLength(cueIds.length);
    for (const w of trace.rows[0]!.cue_weights) expect(w).toBeCloseTo(1.0, 6);
  });

  it('FR-13: dormant neighbor surfaces in the exposure lane with via', async () => {
    const result = await recall(
      makeInput({ sessionId: 's-fr13', query: 'ep-morning', explicitCues: [{ label: 'ep-morning' }] }),
      makeDeps(client, makeEmbed()),
    );
    const exposure = result.memories.filter((m) => m.lane === 'exposure');
    const dorm = exposure.find((m) => m.id === id('OldFriend'));
    expect(dorm).toBeDefined();
    expect(dorm!.via).toBe(id('ep-morning'));
    expect(dorm!.activation).toBeNull();
    // Exposure rows come after all associative rows.
    const lastAssoc = result.memories.map((m) => m.lane).lastIndexOf('associative');
    const firstExposure = result.memories.map((m) => m.lane).indexOf('exposure');
    if (lastAssoc !== -1 && firstExposure !== -1) expect(firstExposure).toBeGreaterThan(lastAssoc);
  });

  it('FR-14: direct lane includes the best fact at sim >= directMinSim and excludes below it', async () => {
    // Query vector == fact-1's embedding: cosine sim 1.0 >= 0.8 → direct row.
    const hit = await recall(
      makeInput({ sessionId: 's-fr14a', query: 'fact-1', explicitCues: [] }),
      makeDeps(client, makeEmbed()),
    );
    expect(hit.memories.some((m) => m.lane === 'direct' && m.id === id('fact-1'))).toBe(true);

    // Cosine 0.79 to fact-1: below directMinSim 0.8 → no direct row.
    const miss = await recall(
      makeInput({ sessionId: 's-fr14b', query: 'below-threshold-q', explicitCues: [] }),
      makeDeps(client, makeEmbed()),
    );
    expect(miss.memories.some((m) => m.lane === 'direct')).toBe(false);
  });

  it('FR-15: exactly one recall_trace row per recall', async () => {
    const before = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM recall_trace WHERE tenant_id = $1 AND query = 'fr15-marker'", [TENANT],
    );
    await recall(makeInput({ sessionId: 's-fr15', query: 'fr15-marker', explicitCues: [{ label: 'Alice' }] }),
      makeDeps(client, makeEmbed()));
    await recall(makeInput({ sessionId: 's-fr15', query: 'fr15-marker', explicitCues: [{ label: 'Alice' }] }),
      makeDeps(client, makeEmbed()));
    const after = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM recall_trace WHERE tenant_id = $1 AND query = 'fr15-marker'", [TENANT],
    );
    expect(Number(after.rows[0]!.n) - Number(before.rows[0]!.n)).toBe(2);
  });

  it('FR-16: repeated recalls leave nodes.access_count and edges.strength byte-identical', async () => {
    const nodesBefore = await client.query('SELECT id, access_count FROM nodes WHERE tenant_id = $1 ORDER BY id', [TENANT]);
    const edgesBefore = await client.query('SELECT id, strength FROM edges WHERE tenant_id = $1 ORDER BY id', [TENANT]);
    for (let i = 0; i < 3; i++) {
      await recall(makeInput({ sessionId: 's-fr16', query: 'Alice', explicitCues: [] }), makeDeps(client, makeEmbed()));
    }
    const nodesAfter = await client.query('SELECT id, access_count FROM nodes WHERE tenant_id = $1 ORDER BY id', [TENANT]);
    const edgesAfter = await client.query('SELECT id, strength FROM edges WHERE tenant_id = $1 ORDER BY id', [TENANT]);
    expect(nodesAfter.rows).toEqual(nodesBefore.rows);
    expect(edgesAfter.rows).toEqual(edgesBefore.rows);
  });

  it('FR-17: prefetch cache hit skips embed; different session and TTL expiry re-embed', async () => {
    const counter: EmbedCounter = { n: 0 };
    const deps = { ...makeDeps(client, makeEmbed(counter)), prefetchTtlSeconds: 600 };
    const first = await runPrefetch('claude-code', 's-prefetch-a', 'Alice', deps);
    expect(counter.n).toBe(1);
    expect(first.text.length).toBeGreaterThan(0);
    const second = await runPrefetch('claude-code', 's-prefetch-a', 'Alice', deps);
    expect(counter.n).toBe(1); // cache hit: no embed call
    expect(second.text).toBe(first.text);
    await runPrefetch('claude-code', 's-prefetch-b', 'Alice', deps); // different session → new entry
    expect(counter.n).toBe(2);
    await runPrefetch('hermes', 's-prefetch-a', 'Alice', deps); // different client → new entry
    expect(counter.n).toBe(3);
    // TTL expiry: an entry cached with TTL 0 is immediately stale, so the next
    // call re-embeds; after it re-caches with TTL 600 the third call hits.
    const shortDeps = { ...deps, prefetchTtlSeconds: 0 };
    await runPrefetch('claude-code', 's-prefetch-ttl', 'Alice', shortDeps);
    expect(counter.n).toBe(4);
    await runPrefetch('claude-code', 's-prefetch-ttl', 'Alice', deps); // expired → re-embed, re-cache TTL 600
    expect(counter.n).toBe(5);
    await runPrefetch('claude-code', 's-prefetch-ttl', 'Alice', deps); // now valid → hit
    expect(counter.n).toBe(5);
  });

  it('NFR-04: prefetch degrades to { text: "" } on slow embed within the 2 s budget', async () => {
    const deps = {
      ...makeDeps(client, () => new Promise<number[]>((resolve) => {
        const t = setTimeout(() => resolve(oneHot(10)), 10_000);
        if (typeof t.unref === 'function') t.unref(); // don't keep the vitest worker alive
      })),
      prefetchTtlSeconds: 600,
    };
    const t0 = Date.now();
    const { text } = await runPrefetch('claude-code', 's-slow-embed', 'Alice', deps);
    const elapsed = Date.now() - t0;
    expect(text).toBe('');
    expect(elapsed).toBeLessThan(4000); // a full (10 s) embed would blow far past this
  });

  it('NFR-04: prefetch degrades to { text: "" } when embed rejects', async () => {
    const deps = {
      ...makeDeps(client, async () => { throw new Error('embed down'); }),
      prefetchTtlSeconds: 600,
    };
    const { text } = await runPrefetch('claude-code', 's-embed-fail', 'Alice', deps);
    expect(text).toBe('');
  });

  it('embed failure degrades to explicit-cue-only results without throwing', async () => {
    const result = await recall(
      makeInput({ sessionId: 's-embed-fail', query: 'Alice', explicitCues: [{ label: 'Alice' }] }),
      makeDeps(client, async () => { throw new Error('embed down'); }),
    );
    const assoc = result.memories.filter((m) => m.lane === 'associative').map((m) => m.id);
    expect(assoc).toContain(id('Bob'));
    expect(assoc).toContain(id('fact-1'));
    expect(result.trace_id).toBeDefined();
  });

  it('FR-18: result.text length never exceeds contextMaxChars', async () => {
    const result = await recall(
      makeInput({ sessionId: 's-fr18', query: 'Alice', explicitCues: [] }),
      makeDeps(client, makeEmbed(), { contextMaxChars: 40 }),
    );
    expect(result.text.length).toBeLessThanOrEqual(40);
    expect(result.memories.length).toBeGreaterThan(0);
  });
});
