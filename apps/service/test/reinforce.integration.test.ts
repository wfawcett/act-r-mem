import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transpileModule, ModuleKind, ScriptTarget, type CompilerOptions } from 'typescript';

import { pool } from '../src/db/pool.js';
import { flushUses, type FlushCounts } from '../src/reinforce/flush.js';
import { forgetNode, restoreNode } from '../src/reinforce/forget.js';
import { UseBuffer } from '../src/reinforce/buffer.js';
import type { Params } from '../src/config.js';

const MIGRATE = path.resolve(process.cwd(), '..', '..', 'db', 'migrate.mjs');
const DAY = 86_400_000;

// Same defaults the service loads from config/params.json (E05); copied locally so the
// suite does not depend on process.cwd().
const PARAMS: Params = {
  decay: 0.5, recentAccesses: 10, minAgeDays: 0.01, tau: -1.0, noiseScale: 0.35, dormantP: 0.2,
  edgeFloor: 0.001, edgeInitial: 1.0, edgeGain: 0.2,
  halfLifeDays: { identity: 180, default: 30, incidental: 7 },
  hops: 3, damping: 0.7, pruneEpsilon: 0.0001, maxExpanded: 2000, seedK: 8, seedMinSim: 0.35,
  spreadWeight: 10, minSpread: 0.02, recallThreshold: 0.5, resultLimit: 10, directMinSim: 0.8,
  reviveExtraAccesses: 2,
};

// Fixed logical clock for every flush — all expectations below are computed against it.
const NOW = 1_750_000_000_000;

async function migrate(): Promise<string> {
  return execFileSync('node', [MIGRATE], { encoding: 'utf8' }).trim();
}

async function seedNode(opts: {
  label: string;
  accessCount?: number;
  createdAt?: number;
  recentAccess?: number[];
}): Promise<number> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO nodes (kind, label, content, label_norm, access_count, created_at, recent_access)
     VALUES ('entity', $1, $1, $1, $2, $3, $4) RETURNING id`,
    [
      opts.label,
      opts.accessCount ?? 1,
      new Date(opts.createdAt ?? NOW),
      (opts.recentAccess ?? [NOW]).map((t) => new Date(t)),
    ],
  );
  return Number(res.rows[0]!.id);
}

async function seedEdge(src: number, dst: number, opts: { strength: number; lastUsedAt: number }) {
  const res = await pool.query<{ id: string; strength: string }>(
    `INSERT INTO edges (src, dst, predicate, strength, last_used_at)
     VALUES ($1, $2, 'with', $3, $4) RETURNING id, strength`,
    [src, dst, opts.strength, new Date(opts.lastUsedAt)],
  );
  return { id: Number(res.rows[0]!.id), strength: Number(res.rows[0]!.strength) };
}

async function seedTrace(hops: Array<{ hop: number; from: number; to: number; edge: number }>) {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO recall_trace (client, cue_ids, cue_weights, hops, recalled, params, duration_ms)
     VALUES ('omp', '{}', '{}', $1, '[]', '{}', 1) RETURNING id`,
    [JSON.stringify(hops.map((h) => ({ ...h, amount: 1 })))],
  );
  return Number(res.rows[0]!.id);
}

async function nodeRow(id: number): Promise<{ access_count: number; recent_access: Date[]; invalid_at: Date | null }> {
  const res = await pool.query(
    `SELECT access_count, recent_access, invalid_at FROM nodes WHERE id = $1`,
    [id],
  );
  return res.rows[0]!;
}

async function edgeRow(id: number): Promise<{ strength: number; last_used_at: Date; invalid_at: Date | null }> {
  const res = await pool.query(
    `SELECT strength, last_used_at, invalid_at FROM edges WHERE id = $1`,
    [id],
  );
  const row = res.rows[0]!;
  return { strength: Number(row.strength), last_used_at: row.last_used_at, invalid_at: row.invalid_at };
}

async function usedIds(traceId: number): Promise<string[]> {
  const res = await pool.query<{ used_ids: string[] }>(
    `SELECT used_ids FROM recall_trace WHERE id = $1`,
    [traceId],
  );
  return res.rows[0]!.used_ids;
}

// Strengthening expectation: one reinforceEdge from the seeded strength (decay floored or not
// is up to the implementation — we compute it from the row that flushUses read).
function reinforcedOnce(strength: number, lastUsedAtMs: number, halfLifeDays: number): number {
  const decayed = Math.max(
    PARAMS.edgeFloor,
    strength * Math.pow(0.5, Math.max(0, NOW - lastUsedAtMs) / DAY / halfLifeDays),
  );
  return Math.min(1, decayed + PARAMS.edgeGain * (1 - decayed));
}

// --- (f) SIGTERM child-process flush ------------------------------------------
// The service TS sources are transpiled at test time into a temp dir so a plain `node`
// child can attach a UseBuffer, go idle with a pending use, and prove the SIGTERM
// shutdown hook flushes it before exit (FR-19/NFR-06).
// Under apps/service so the transpiled child resolves 'pg' and 'typescript' from this
// package's node_modules (a bare tmpdir would not see workspace deps).
const CHILD_DIR = path.join(process.cwd(), 'test', `.sigterm-child-${process.pid}`);
const ROOT = path.resolve(process.cwd(), '..', '..');

function transpile(rel: string, rewrite: Array<[RegExp, string]> = []): string {
  const src = readFileSync(path.join(ROOT, rel), 'utf8');
  const options: CompilerOptions = {
    module: ModuleKind.ESNext,
    target: ScriptTarget.ES2022,
    esModuleInterop: true,
  };
  let out = transpileModule(src, { compilerOptions: options }).outputText;
  for (const [re, to] of rewrite) out = out.replace(re, to);
  return out;
}

function buildChild(): string {
  rmSync(CHILD_DIR, { recursive: true, force: true });
  mkdirSync(path.join(CHILD_DIR, 'reinforce'), { recursive: true });
  writeFileSync(path.join(CHILD_DIR, 'pool.js'), transpile('apps/service/src/db/pool.ts'));
  writeFileSync(path.join(CHILD_DIR, 'reinforce', 'buffer.js'), transpile('apps/service/src/reinforce/buffer.ts'));
  writeFileSync(
    path.join(CHILD_DIR, 'reinforce', 'flush.js'),
    transpile('apps/service/src/reinforce/flush.ts', [[/@recall\/activation/g, '../activation.js']]),
  );
  writeFileSync(path.join(CHILD_DIR, 'reinforce', 'forget.js'), transpile('apps/service/src/reinforce/forget.ts'));
  writeFileSync(path.join(CHILD_DIR, 'reinforce', 'index.js'), transpile('apps/service/src/reinforce/index.ts'));
  // activation's only runtime export surface is functions; its `import type { … } from './types.js'`
  // is elided by the transpile, so a single self-contained file is enough.
  writeFileSync(path.join(CHILD_DIR, 'activation.js'), transpile('packages/activation/src/index.ts'));

  const child = `
import { pool } from './pool.js';
import { attachUseBuffer } from './reinforce/index.js';

const params = JSON.parse(process.env.E08_PARAMS);
const app = { decorate(name, value) { this[name] = value; return this; } };
const buffer = attachUseBuffer(app, { pool, params, useFlushMs: 3_600_000 });
buffer.add({ nodeId: Number(process.argv[2]), traceId: Number(process.argv[3]) });
console.log('child-ready size=' + buffer.size());
// Keep the event loop alive until the signal arrives (the buffer timer is unref'd).
setInterval(() => {}, 1 << 30);
// The SIGTERM flush is registered by attachUseBuffer; we only close the pool after
// giving that async flush time to land, then exit 0.
process.on('SIGTERM', () => {
  setTimeout(() => pool.end().then(() => process.exit(0)), 500);
});
`;
  writeFileSync(path.join(CHILD_DIR, 'child.mjs'), child);
  return path.join(CHILD_DIR, 'child.mjs');
}

function runChild(childPath: string, nodeId: number, traceId: number): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childPath, String(nodeId), String(traceId)], {
      env: { ...process.env, E08_PARAMS: JSON.stringify(PARAMS) },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.on('error', reject);
    // Send SIGTERM only once the child is idle with its pending use (its own
    // 15s keepalive keeps it alive; the attachUseBuffer timer is unref'd).
    const signal = setInterval(() => {
      if (stdout.includes('child-ready')) {
        clearInterval(signal);
        child.kill('SIGTERM');
      }
    }, 20);
    child.on('close', (code) => resolve({ stdout, code }));
  });
}

const DbIntegration = process.env.DATABASE_URL ? describe : describe.skip;

DbIntegration('reinforce integration (E08 tasks 3/4/5/6)', () => {
  let childPath: string;

  beforeAll(async () => {
    // Hermetic reset, same pattern as test/db.integration.test.ts.
    await pool.query(`
      DROP TABLE IF EXISTS recall_trace, ingest_queue, sessions, edges, nodes, schema_migrations CASCADE;
      DROP TYPE IF EXISTS node_kind
    `);
    expect(await migrate()).toContain('applied 0001_init.sql');
    expect(await migrate()).toContain('no migrations to apply');
    childPath = buildChild();
  });

  afterAll(async () => {
    rmSync(CHILD_DIR, { recursive: true, force: true });
    await pool.end();
  });

  it('(a) bumps a dormant node with +reviveExtraAccesses and a fresh node without', async () => {
    const old = NOW - 60 * DAY;
    const dormantId = await seedNode({
      label: 'dormant-apple',
      accessCount: 1,
      createdAt: old,
      recentAccess: [old],
    });
    const freshId = await seedNode({ label: 'fresh-apple', accessCount: 1 });

    const counts: FlushCounts = await flushUses(pool, PARAMS, [{ nodeId: dormantId }, { nodeId: freshId }], NOW);
    expect(counts.nodes).toBe(2);
    expect(counts.edges).toBe(0);

    const dormant = await nodeRow(dormantId);
    expect(dormant.access_count).toBe(1 + 1 + PARAMS.reviveExtraAccesses); // +3
    expect(dormant.recent_access[0]!.getTime()).toBe(NOW);
    expect(dormant.recent_access).toHaveLength(4);

    const fresh = await nodeRow(freshId);
    expect(fresh.access_count).toBe(2); // not dormant: plain +1
    expect(fresh.recent_access[0]!.getTime()).toBe(NOW);
    expect(fresh.recent_access).toHaveLength(2);
  });

  it('(b,c,d) reinforces path edges once per edge per flush, bumps no-traceId node only, appends used_ids', async () => {
    const a = await seedNode({ label: 'chain-a', createdAt: NOW - DAY, recentAccess: [NOW - DAY] });
    const b = await seedNode({ label: 'chain-b', createdAt: NOW - DAY, recentAccess: [NOW - DAY] });
    const c = await seedNode({ label: 'chain-c', createdAt: NOW - DAY, recentAccess: [NOW - DAY] });
    const oldUsed = NOW - 30 * DAY; // 'default' half-life: strength halves exactly once
    const e1 = await seedEdge(a, b, { strength: 0.5, lastUsedAt: oldUsed });
    const e2 = await seedEdge(b, c, { strength: 0.5, lastUsedAt: oldUsed });
    const untouched = await seedEdge(a, c, { strength: 0.5, lastUsedAt: oldUsed });
    const trace = await seedTrace([
      { hop: 1, from: a, to: b, edge: e1.id },
      { hop: 2, from: b, to: c, edge: e2.id },
    ]);

    // Duplicate (traceId, nodeId) plus a second node on the same trace: e1 is on both
    // paths but must be reinforced exactly ONCE per flush.
    const counts = await flushUses(
      pool,
      PARAMS,
      [{ nodeId: c, traceId: trace }, { nodeId: c, traceId: trace }, { nodeId: b, traceId: trace }],
      NOW,
    );
    expect(counts).toEqual({ nodes: 2, edges: 2, traces: 1 });

    const expected = reinforcedOnce(0.5, oldUsed, PARAMS.halfLifeDays.default!);
    for (const e of [e1, e2]) {
      const row = await edgeRow(e.id);
      expect(row.strength).toBeCloseTo(expected, 6);
      expect(row.last_used_at.getTime()).toBe(NOW);
    }
    // Off-path edge untouched.
    const off = await edgeRow(untouched.id);
    expect(off.strength).toBeCloseTo(0.5, 6);
    expect(off.last_used_at.getTime()).toBe(oldUsed);

    // (d) used_ids appended with exactly the used nodes, deduped.
    expect([...(await usedIds(trace))].sort()).toEqual([String(c), String(b)].sort());

    // (c) a use without traceId bumps the node only: no edges, no trace touched.
    const solo = await seedNode({ label: 'solo-node' });
    const soloCounts = await flushUses(pool, PARAMS, [{ nodeId: solo }], NOW);
    expect(soloCounts).toEqual({ nodes: 1, edges: 0, traces: 0 });
    expect([...(await usedIds(trace))].sort()).toEqual([String(c), String(b)].sort()); // unchanged
  });

  it('(e) forgetNode/restoreNode flip invalid_at on the node and its incident edges', async () => {
    const a = await seedNode({ label: 'forget-a' });
    const b = await seedNode({ label: 'forget-b' });
    const other = await seedNode({ label: 'forget-other' });
    const e1 = await seedEdge(a, b, { strength: 0.5, lastUsedAt: NOW });
    const e2 = await seedEdge(other, a, { strength: 0.5, lastUsedAt: NOW });

    await forgetNode(pool, a);
    expect((await nodeRow(a)).invalid_at).not.toBeNull();
    expect((await edgeRow(e1.id)).invalid_at).not.toBeNull();
    expect((await edgeRow(e2.id)).invalid_at).not.toBeNull();
    expect((await nodeRow(b)).invalid_at).toBeNull();

    await restoreNode(pool, a);
    expect((await nodeRow(a)).invalid_at).toBeNull();
    expect((await edgeRow(e1.id)).invalid_at).toBeNull();
    expect((await edgeRow(e2.id)).invalid_at).toBeNull();
  });

  it('(f) a child process with a pending use flushes it on SIGTERM before exiting', async () => {
    const used = await seedNode({ label: 'sigterm-node', createdAt: NOW - DAY, recentAccess: [NOW - DAY] });
    const a = await seedNode({ label: 'sigterm-a', createdAt: NOW - DAY, recentAccess: [NOW - DAY] });
    const e = await seedEdge(a, used, { strength: 0.5, lastUsedAt: NOW - DAY });
    const trace = await seedTrace([{ hop: 1, from: a, to: used, edge: e.id }]);

    // Nothing flushed yet.
    const before = await nodeRow(used);
    expect(before.access_count).toBe(1);

    const { stdout, code } = await runChild(childPath, used, trace);
    expect(stdout).toContain('child-ready size=1'); // pending before the signal
    expect(code).toBe(0);

    const after = await nodeRow(used);
    expect(after.access_count).toBeGreaterThan(before.access_count);
    expect([...(await usedIds(trace))].sort()).toEqual([String(used)]);
    expect((await edgeRow(e.id)).last_used_at.getTime()).toBeGreaterThan(0);
  });

  it('(g) un-flushed uses stay pending in the buffer and are not in the DB', async () => {
    const pending = await seedNode({ label: 'pending-node', createdAt: NOW - 60 * DAY, recentAccess: [NOW - 60 * DAY] });
    const before = await nodeRow(pending);

    const buffer = new UseBuffer({ pool, params: PARAMS, useFlushMs: 0 });
    buffer.add({ nodeId: pending });
    expect(buffer.size()).toBe(1);
    // No flush, no running timer: the buffered use must not have reached the DB.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await nodeRow(pending)).access_count).toBe(before.access_count);

    // An explicit flush lands exactly the pending batch (at most one interval of uses lost).
    await buffer.flush();
    expect(buffer.size()).toBe(0);
    expect((await nodeRow(pending)).access_count).toBe(before.access_count + 1 + PARAMS.reviveExtraAccesses);
    buffer.stop();
  });
});
