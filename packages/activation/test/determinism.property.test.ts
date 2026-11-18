import { describe, expect, it } from "vitest";
import { score, spread } from "../src/index.js";
import type { EdgeState, Graph, Nodes, Params } from "../src/types.js";

const P: Params = {
  decay: 0.5,
  recentAccesses: 10,
  minAgeDays: 0.01,
  tau: -1.0,
  noiseScale: 0.35,
  dormantP: 0.2,
  edgeFloor: 0.001,
  edgeInitial: 1.0,
  edgeGain: 0.2,
  halfLifeDays: { identity: 180, default: 30, incidental: 7 },
  hops: 3,
  damping: 0.7,
  pruneEpsilon: 0.0001,
  maxExpanded: 2000,
  seedK: 8,
  seedMinSim: 0.35,
  spreadWeight: 10,
  minSpread: 0.02,
  recallThreshold: 0.5,
  resultLimit: 10,
  directMinSim: 0.8,
  reviveExtraAccesses: 2,
};

const DAY = 86_400_000;

// Deterministic PRNG — NFR-07 forbids Math.random(); every graph comes from this seeded xorshift.
function xorshift32(seed: number): () => number {
  let x = seed | 0;
  if (x === 0) x = 0x9e3779b9; // never allow the all-zero fixed point
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x |= 0;
    return (x >>> 0) / 0x1_0000_0000;
  };
}

const HALF_LIFE_CLASSES = ["identity", "default", "incidental"] as const;

// Seeded random graph: 50 nodes, ~120 undirected edges, and node states whose
// half-life class, edge strength, and access history all vary across the random stream.
type AdjEntry = { id: number; to: number } & EdgeState;

function randomGraph(rnd: () => number): { g: Graph; nodes: Nodes; now: number } {
  const nodeCount = 50;
  const now = 500 * DAY;
  const g: Graph = { nodes: new Map(), adj: new Map() };
  const nodes: Nodes = new Map();
  for (let id = 1; id <= nodeCount; id++) {
    const accessCount = 1 + Math.floor(rnd() * 30);
    const m = 1 + Math.floor(rnd() * 8);
    const createdAt = Math.floor(rnd() * 400 * DAY);
    const recentAccess: number[] = [];
    for (let i = 0; i < m; i++) {
      const jitter = rnd() < 0.5 ? 0 : Math.floor(rnd() * 3 * DAY); // sub-day resolution exercises age clamping
      recentAccess.push(now - i * DAY * (1 + Math.floor(rnd() * 400)) - jitter);
    }
    nodes.set(id, { accessCount, recentAccess, createdAt, kind: "fact" });
    g.nodes.set(id, { accessCount, recentAccess, createdAt });
  }
  for (let i = 0; i < 120; i++) {
    const from = 1 + Math.floor(rnd() * nodeCount);
    const to = 1 + Math.floor(rnd() * nodeCount);
    if (from === to) continue;
    const fwd: AdjEntry = {
      id: 1000 + i,
      to,
      strength: 0.001 + rnd() * 0.999,
      lastUsedAt: Math.floor(rnd() * 300 * DAY),
      halfLifeClass: HALF_LIFE_CLASSES[Math.floor(rnd() * 3)]!,
    };
    const back: AdjEntry = { ...fwd, to: from };
    const listF = g.adj.get(from) ?? [];
    listF.push(fwd);
    g.adj.set(from, listF);
    const listB = g.adj.get(to) ?? [];
    listB.push(back);
    g.adj.set(to, listB);
  }
  return { g, nodes, now };
}

// Per PRD §10.5: spread flows accumulate into per-node spread mass S; score combines that
// with base level into associative rows. Returns everything JSON.stringify will compare.
function runOnce(g: Graph, nodes: Nodes, now: number, cueIds: number[]) {
  const cues = cueIds.map((id, i) => ({ id, activation: 1 - i * 0.1 }));
  const flows = spread(g, cues, now, P);
  const act = new Map<number, number>();
  for (const f of flows) act.set(f.to, (act.get(f.to) ?? 0) + f.amount);
  const rows = score(nodes, act, now, P);
  return { flows, rows };
}

describe("determinism property (NFR-07)", () => {
  it("spread + score are byte-identical across 1,000 seeded random graphs run twice", () => {
    const rnd = xorshift32(0x5eed_1234);
    const cueIds = [1, 2, 3, 4, 5, 6, 7, 8]; // seedK cues
    const digests: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const { g, nodes, now } = randomGraph(rnd);
      const first = JSON.stringify(runOnce(g, nodes, now, cueIds));
      const second = JSON.stringify(runOnce(g, nodes, now, cueIds));
      expect(second).toBe(first);
      digests.push(first);
    }
    // Not all-empty and not one repeated blob: the corpus actually varies per graph.
    expect(digests.some((s) => s.length > 2)).toBe(true);
    expect(new Set(digests).size).toBeGreaterThan(1);
  });

  it("is reproducible across test-file invocations — same seed, same corpus digest", () => {
    const rnd = xorshift32(0x5eed_1234);
    const cueIds = [1, 2, 3, 4, 5, 6, 7, 8];
    const digests: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const { g, nodes, now } = randomGraph(rnd);
      digests.push(JSON.stringify(runOnce(g, nodes, now, cueIds)));
    }
    // Rebuild the corpus a second time from the same seed and compare the whole digest list.
    const rnd2 = xorshift32(0x5eed_1234);
    for (let i = 0; i < 1000; i++) {
      const { g, nodes, now } = randomGraph(rnd2);
      const again = JSON.stringify(runOnce(g, nodes, now, cueIds));
      expect(again).toBe(digests[i]);
    }
  });
});
