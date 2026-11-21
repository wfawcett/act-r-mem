// Recall latency smoke test (card #15, task 8) at benchmark fixture scale:
// 10,000 nodes / 50,000 edges (PRD §15.4 scale), measuring p95 of N recall()
// calls without embed (< 150 ms, NFR-01) and with the stub embed (< 400 ms,
// NFR-02). The full `pnpm bench` run lands in E14.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { pool } from '../src/db/pool.js';
import type { Params } from '../src/config.js';
import type { RecallDeps } from '../src/recall/deps.js';
import { recall } from '../src/recall/pipeline.js';
import { loadBenchFixture } from './fixtures/load-bench-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATE = path.resolve(HERE, '..', '..', '..', 'db', 'migrate.mjs');
const DATABASE_URL = 'postgres://recall:recall@localhost:5433/recall_test';

const PARAMS: Params = {
  decay: 0.5, recentAccesses: 10, minAgeDays: 0.01, tau: -1.0, noiseScale: 0.35, dormantP: 0.2,
  edgeFloor: 0.001, edgeInitial: 1.0, edgeGain: 0.2, halfLifeDays: { identity: 180, default: 30, incidental: 7 },
  hops: 3, damping: 0.7, pruneEpsilon: 0.0001, maxExpanded: 2000, seedK: 8, seedMinSim: 0.35,
  spreadWeight: 10, minSpread: 0.02, recallThreshold: 0.5, resultLimit: 10, directMinSim: 0.8, reviveExtraAccesses: 2,
};

const NODES = 10_000;
const EDGES = 50_000;
const RUNS = 50;

let client: PoolClient;
function deps(embed: RecallDeps['embed']): RecallDeps {
  return { embed, db: client, params: PARAMS };
}

/** Deterministic cue set: i-th run uses a fixed pseudo-random node id. */
function cueFor(i: number): number {
  return ((i * 4373 + 17) % NODES) + 1;
}

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
}

const Latency = process.env.DATABASE_URL ? describe : describe.skip;

Latency('recall latency at fixture scale', () => {
  beforeAll(async () => {
    await pool.query(`
      DROP TABLE IF EXISTS recall_trace, ingest_queue, sessions, edges, nodes, schema_migrations CASCADE;
      DROP TYPE IF EXISTS node_kind
    `);
    execFileSync('node', [MIGRATE], { encoding: 'utf8', env: { ...process.env, DATABASE_URL } });
    client = await pool.connect();
    const counts = await loadBenchFixture(client, { nodes: NODES, edges: EDGES });
    expect(counts.nodes).toBe(NODES);
  }, 300_000);

  afterAll(async () => {
    client.release();
    await pool.end();
  });

  it('NFR-01: p95 recall without embed < 150 ms (explicit cues, embed stub failing)', async () => {
    const noEmbed = async (): Promise<number[]> => {
      throw new Error('no embed in this measurement');
    };
    const samples: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = process.hrtime.bigint();
      await recall(
        { tenant: 'local', sessionId: `lat-n-1`, query: 'q', explicitCues: [{ id: cueFor(i) }] },
        deps(noEmbed),
      );
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const p = p95(samples);
    expect(p).toBeLessThan(150);
  }, 120_000);

  it('NFR-02: p95 recall with stub embed < 400 ms', async () => {
    // Deterministic stub vector: in the 1/(seedK) tail so the vector search runs.
    const stubVec: number[] = new Array(768).fill(0);
    stubVec[0] = 1;
    const stub = async (): Promise<number[]> => stubVec;
    const samples: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = process.hrtime.bigint();
      await recall(
        { tenant: 'local', sessionId: 'lat-e-1', query: `q:${i}`, explicitCues: [{ id: cueFor(i) }] },
        deps(stub),
      );
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const p = p95(samples);
    expect(p).toBeLessThan(400);
  }, 120_000);
});
