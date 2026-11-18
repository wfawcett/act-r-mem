import { describe, expect, it } from "vitest";
import { spread } from "../src/index.js";
import type { EdgeState } from "../src/types.js";
import type { Params } from "../src/types.js";
import type { Graph } from "../src/index.js";

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

// Build a Graph with an adjacency list from plain edges (spread ignores graph.nodes here).
function graphFrom(edges: { id: number; from: number; to: number; w?: number }[]): Graph {
  const adj = new Map<number, Array<EdgeState & { id: number }>>();
  for (const e of edges) {
    const list = adj.get(e.from) ?? [];
    list.push({
      id: e.id,
      to: e.to,
      strength: e.w ?? 1,
      lastUsedAt: 0,
      halfLifeClass: "default",
    });
    adj.set(e.from, list);
  }
  return { nodes: new Map(), adj };
}

describe("spread — fan division (SC-07)", () => {
  it("gives a target more spread when its linking cue has few edges than many (equal strength)", () => {
    const now = 0;
    // Target 10 linked to cue A by one edge vs. target 20 linked to cue B by two equal edges.
    const few = graphFrom([{ id: 1, from: 100, to: 10 }]);
    const many = graphFrom([
      { id: 2, from: 200, to: 20 },
      { id: 3, from: 200, to: 21 },
    ]);
    const fFew = spread(few, [{ id: 100, activation: 1 }], now, P);
    const fMany = spread(many, [{ id: 200, activation: 1 }], now, P);
    // Same edge weight (1), but fan 1 vs. fan 2 → the low-fan path carries more to its target.
    expect(fFew[0].amount).toBeGreaterThan(fMany[0].amount);
    expect(fFew[0].amount).toBeCloseTo((1 * 1 * P.damping) / 1, 12);
    expect(fMany[0].amount).toBeCloseTo((1 * 1 * P.damping) / 2, 12);
  });

  it("divides by the true fan even with several outgoing edges", () => {
    const now = 0;
    const adj = new Map([
      [1, Array.from({ length: 5 }, (_, i) => ({ to: 10 + i, id: 100 + i, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }))],
    ]);
    const flows = spread({ nodes: new Map(), adj }, [{ id: 1, activation: 2 }], now, P);
    // fan = 5, so each flow carries 2·1·δ/5.
    expect(flows.length).toBe(5);
    for (const f of flows) expect(f.amount).toBeCloseTo((2 * 1 * P.damping) / 5, 12);
  });
});

describe("spread — hop limit and multi-hop", () => {
  it("spreads up to p.hops hops and stops there", () => {
    const now = DAY;
    // A → B → C → D → E with hops=3: D (3 hops away) is reachable, E (4 hops) is not.
    const adj = new Map([
      [1, [{ to: 2, id: 11, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }]],
      [2, [{ to: 3, id: 12, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }]],
      [3, [{ to: 4, id: 13, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }]],
      [4, [{ to: 5, id: 14, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }]],
    ]);
    const flows = spread({ nodes: new Map(), adj }, [{ id: 1, activation: 1 }], now, P);
    // Nodes reached at hops 1..3: ids 2,3,4. Hop-4 flow to 5 is absent (H=3).
    expect(flows.map((f) => f.to)).toEqual([2, 3, 4]);
    const hopMax = Math.max(...flows.map((f) => f.hop));
    expect(hopMax).toBe(3);
  });

  it("accumulates activation at a node reached via multiple hops", () => {
    const now = DAY;
    // Two independent two-hop paths into target 9.
    const adj = new Map([
      [1, [{ to: 2, id: 1, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }]],
      [2, [{ to: 9, id: 2, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }]],
      [3, [{ to: 4, id: 3, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }]],
      [4, [{ to: 9, id: 4, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }]],
    ]);
    const flows = spread({ nodes: new Map(), adj }, [{ id: 1, activation: 1 }, { id: 3, activation: 1 }], now, P);
    // Target 9 received two separate hop-2 flows.
    const to9 = flows.filter((f) => f.to === 9);
    expect(to9.length).toBe(2);
    expect(to9.every((f) => f.hop === 2)).toBe(true);
  });
});

describe("spread — pruning below epsilon", () => {
  it("keeps a flow above epsilon and prunes one below it", () => {
    const now = DAY;
    // amount = activation·strength·δ/fan. With strength=1, fan=1: act=1 → 0.7 (kept); act=0.0001 → 7e-5 (pruned).
    const adj = new Map([[1, [{ to: 2, id: 1, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }]]]);
    const kept = spread({ nodes: new Map(), adj }, [{ id: 1, activation: 1 }], now, P);
    expect(kept.length).toBe(1);
    const pruned = spread({ nodes: new Map(), adj }, [{ id: 1, activation: 0.0001 }], now, P);
    expect(pruned.length).toBe(0);
  });

  it("drops every share when a large fan pushes each below epsilon", () => {
    const now = DAY;
    // act=0.05, fan=2000: share ≈ 0.05·δ/2000 ≈ 1.75e-6 < ε → all pruned even though the sum exceeds ε.
    const adj = new Map([[1, Array.from({ length: 2000 }, (_, i) => ({ to: 10 + i, id: 300 + i, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }))]]);
    const flows = spread({ nodes: new Map(), adj }, [{ id: 1, activation: 0.05 }], now, P);
    expect(flows.length).toBe(0);
  });

  it("floors edge at edgeFloor but still emits a flow when above epsilon", () => {
    const now = DAY;
    // A floor-strength edge (0.001) with activation 1, fan 1: amount = 0.001·δ = 7e-4 ≥ ε → kept and traversed.
    const e: EdgeState = { strength: P.edgeFloor, lastUsedAt: 0, halfLifeClass: "default" };
    const adj = new Map([[1, [{ to: 2, id: 7, strength: e.strength, lastUsedAt: e.lastUsedAt, halfLifeClass: e.halfLifeClass }]]]);
    const flows = spread({ nodes: new Map(), adj }, [{ id: 1, activation: 1 }], now, P);
    expect(flows.length).toBe(1);
    expect(flows[0].amount).toBeCloseTo(P.edgeFloor * P.damping, 12);
  });
});

describe("spread — cues never receive activation", () => {
  it("skips edges that point back to any cue id", () => {
    const now = DAY;
    // Cue A (1) and cue B (2) are mutually linked; neither should gain a flow.
    const adj = new Map([
      [1, [{ to: 2, id: 1, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }]],
      [2, [{ to: 1, id: 2, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }]],
    ]);
    const flows = spread({ nodes: new Map(), adj }, [{ id: 1, activation: 1 }, { id: 2, activation: 1 }], now, P);
    expect(flows.length).toBe(0); // every neighbor is itself a cue.
  });

  it("spreads away from a cue but not to it when the same id appears as both source and target", () => {
    const now = DAY;
    const adj = new Map([
      [1, [{ to: 2, id: 1, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }]],
      [2, [{ to: 1, id: 2, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }]],
    ]);
    // Only cue is 1; edge back to 2 (a non-cue) flows, but the edge from 2 back to cue 1 does not.
    const flows = spread({ nodes: new Map(), adj }, [{ id: 1, activation: 1 }], now, P);
    expect(flows.map((f) => f.edge).sort()).toEqual([1]); // only the forward edge survives; the back-edge to cue is dropped.
  });
});

describe("spread — frontier ordering (activation desc, then id asc)", () => {
  it("expands higher-activation sources first", () => {
    const now = DAY;
    // Two independent cues at hop 1 pointing into distinct leaf targets so order is observable in flow `from`.
    const adj = new Map([
      [20, [{ to: 200, id: 1, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }]],
      [10, [{ to: 100, id: 2, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }]],
    ]);
    const flows = spread({ nodes: new Map(), adj }, [{ id: 10, activation: 0.3 }, { id: 20, activation: 0.9 }], now, P);
    // The 0.9 cue (id 20) is expanded first → its flow appears first.
    expect(flows[0].from).toBe(20);
  });

  it("breaks ties by ascending id when activation is equal", () => {
    const now = DAY;
    const adj = new Map([
      [5, [{ to: 50, id: 1, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }]],
      [3, [{ to: 30, id: 2, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }]],
    ]);
    const flows = spread({ nodes: new Map(), adj }, [{ id: 5, activation: 0.5 }, { id: 3, activation: 0.5 }], now, P);
    // Equal activation → lower id (3) expands first.
    expect(flows[0].from).toBe(3);
  });

  it("is deterministic across runs for the same graph and cues", () => {
    const now = DAY;
    const adj = new Map([
      [1, [{ to: 2, id: 1, strength: 0.5, lastUsedAt: 0, halfLifeClass: "default" as const }]],
      [2, [{ to: 3, id: 2, strength: 0.9, lastUsedAt: 0, halfLifeClass: "default" as const }]],
    ]);
    const a = spread({ nodes: new Map(), adj }, [{ id: 1, activation: 0.4 }], now, P);
    const b = spread({ nodes: new Map(), adj }, [{ id: 1, activation: 0.4 }], now, P);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("spread — maxExpanded cap", () => {
  it("expands a single-hop fan fully when no second hop exists", () => {
    const now = DAY;
    // One source fan of 60 leaves (no outgoing edges) → exactly 60 single-hop flows.
    const adj = new Map([[1, Array.from({ length: 60 }, (_, i) => ({ to: 100 + i, id: 1 + i, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }))]]);
    const flows = spread({ nodes: new Map(), adj }, [{ id: 1, activation: 1 }], now, P);
    expect(flows.length).toBe(60);
  });

  it("honors maxExpanded when expansion would exceed it", () => {
    const now = DAY;
    // A chain A→B→C→D. With N_max=2 only the first two flows survive before the cap trips.
    const adj = new Map([
      [1, [{ to: 2, id: 1, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }]],
      [2, [{ to: 3, id: 2, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }]],
      [3, [{ to: 4, id: 3, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }]],
    ]);
    const tighter: Params = { ...P, maxExpanded: 2 };
    const tFlows = spread({ nodes: new Map(), adj }, [{ id: 1, activation: 1 }], now, tighter);
    expect(tFlows.length).toBe(2);

    // N_max=3 allows the full chain.
    const full: Params = { ...P, maxExpanded: 3 };
    const fFlows = spread({ nodes: new Map(), adj }, [{ id: 1, activation: 1 }], now, full);
    expect(fFlows.length).toBe(3);
  });

  it("never exceeds N_max expanded nodes even with a wide fan across hops", () => {
    const now = DAY;
    // Two-hop star: source fans out to many intermediates, each of which fans to many leaves. Cap keeps expansion bounded.
    const firstFan = Array.from({ length: 40 }, (_, i) => ({ to: 100 + i, id: 1 + i, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }));
    const secondAdj = new Map<number, Array<EdgeState & { id: number }>>([[1, firstFan]]);
    for (let k = 2; k <= 40; k++) secondAdj.set(k, [{ to: 1000 + k, id: 500 + k, strength: 1, lastUsedAt: 0, halfLifeClass: "default" as const }]);
    secondAdj.set(1, firstFan);
    const adj = new Map([[1, firstFan], ...secondAdj.entries()]);
    const capped: Params = { ...P, maxExpanded: 10 };
    const flows = spread({ nodes: new Map(), adj }, [{ id: 1, activation: 1 }], now, capped);
    // Each expanded source node contributes at least one flow; total flows ≤ N_max expanded sources.
    expect(flows.length).toBeLessThanOrEqual(10);
  });
});
