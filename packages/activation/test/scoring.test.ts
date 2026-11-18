import { describe, expect, it } from "vitest";
import { baseLevel, isDormantNode, pathEdges, score, spread } from "../src/index.js";
import type { EdgeState, Flow, Kind, NodeState, Nodes, Params } from "../src/types.js";

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

// score() derives B from the node state, so tests pin B through the node:
//   hot:   one access right now → age clamps to minAgeDays (0.01 d) → Σ Δt^-d = 0.01^-0.5 = 10 → B = ln 10 ≈ 2.303
//   zeroB: one access exactly one day old, nothing unstored → Σ Δt^-d = 1^-0.5 = 1 → B = ln 1 = 0
function hot(now: number, id: number, kind: Kind = "fact"): [number, NodeState & { kind: Kind }] {
  return [id, { accessCount: 1, recentAccess: [now], createdAt: now, kind }];
}
function zeroB(now: number, id: number, kind: Kind = "fact"): [number, NodeState & { kind: Kind }] {
  return [id, { accessCount: 1, recentAccess: [now - DAY], createdAt: 0, kind }];
}

describe("score — S ≥ minSpread gate", () => {
  it("drops nodes whose spread mass is just below minSpread even when B alone would pass", () => {
    const now = DAY;
    const nodes: Nodes = new Map([hot(now, 7)]); // B = ln 10 ≈ 2.303 ≥ τ_A, so only S can exclude.
    // A = 2.303 + 10·0.0199 ≈ 2.50 would pass, but S = 0.0199 < θ_min = 0.02.
    expect(score(nodes, new Map([[7, 0.0199]]), now, P)).toEqual([]);
  });

  it("keeps the boundary S == minSpread (gate is strict '<')", () => {
    const now = DAY;
    const nodes: Nodes = new Map([hot(now, 7)]);
    const out = score(nodes, new Map([[7, P.minSpread]]), now, P);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe(7);
    expect(out[0]?.S).toBe(0.02);
  });

  it("skips ids that are missing from the nodes map (no state → no row)", () => {
    const now = DAY;
    const nodes: Nodes = new Map([hot(now, 7)]);
    const out = score(nodes, new Map<number, number>([[99, 5], [7, 0.5]]), now, P);
    expect(out.map((r) => r.id)).toEqual([7]);
  });
});

describe("score — A = B + spreadWeight·S ≥ recallThreshold gate", () => {
  it("drops a row whose total activation lands just below the threshold", () => {
    const now = DAY;
    const nodes: Nodes = new Map([zeroB(now, 2)]);
    // A = 0 + 10·0.049 = 0.49 < τ_A = 0.5.
    expect(score(nodes, new Map([[2, 0.049]]), now, P)).toEqual([]);
  });

  it("includes the boundary A == recallThreshold (gate is '>=') and reports the row fields", () => {
    const now = DAY;
    const nodes: Nodes = new Map([zeroB(now, 1)]);
    const out = score(nodes, new Map([[1, 0.05]]), now, P);
    // A = 0 + 10·0.05 = 0.5 exactly.
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ id: 1, A: 0.5, B: 0, S: 0.05 });
  });

  it("lets a hot base level carry recall even with minimal spread", () => {
    const now = DAY;
    const nodes: Nodes = new Map([hot(now, 4)]);
    const out = score(nodes, new Map([[4, 0.021]]), now, P);
    expect(out).toHaveLength(1);
    expect(out[0]?.B).toBeCloseTo(Math.log(10), 12);
    expect(out[0]?.A).toBeCloseTo(Math.log(10) + P.spreadWeight * 0.021, 12);
  });
});

describe("score — A-desc / id-asc ordering and resultLimit", () => {
  it("sorts by A descending regardless of activation-map insertion order", () => {
    const now = DAY;
    const nodes: Nodes = new Map([zeroB(now, 3), zeroB(now, 9), zeroB(now, 5)]);
    // Insert lowest-A first: output order must still be A desc (λ·S = 5, 3, 1).
    const act = new Map<number, number>([[3, 0.1], [9, 0.5], [5, 0.3]]);
    expect(score(nodes, act, now, P).map((r) => r.id)).toEqual([9, 5, 3]);
  });

  it("breaks exact A ties by ascending id", () => {
    const now = DAY;
    const nodes: Nodes = new Map([zeroB(now, 8), zeroB(now, 2)]);
    const out = score(nodes, new Map([[8, 0.2], [2, 0.2]]), now, P);
    // Identical node states and S → identical A = 2; lower id comes first.
    expect(out.map((r) => r.id)).toEqual([2, 8]);
    expect(out[0]?.A).toBe(out[1]?.A);
  });

  it("cuts to the top resultLimit rows, keeping the lower id on a cut-boundary tie", () => {
    const now = DAY;
    const nodes: Nodes = new Map([
      zeroB(now, 1),
      zeroB(now, 2),
      zeroB(now, 3),
      zeroB(now, 4),
      zeroB(now, 5),
    ]);
    // A = λ·S: 5, 3, 2, 2, 1 for ids 1..5; the A = 2 tie sits exactly on the limit-3 cut.
    const act = new Map<number, number>([[5, 0.1], [4, 0.2], [3, 0.2], [2, 0.3], [1, 0.5]]);
    const out = score(nodes, act, now, { ...P, resultLimit: 3 });
    expect(out.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(out.map((r) => r.A)).toEqual([5, 3, 2]);
  });
});

describe("pathEdges — backward walk collecting edge ids", () => {
  it("returns no edges for empty flows", () => {
    expect(pathEdges([], 42)).toEqual([]);
  });

  it("walks a linear chain backwards from the target, deepest edge first", () => {
    const flows: Flow[] = [
      { hop: 1, from: 1, to: 2, edge: 101, amount: 0.7 },
      { hop: 2, from: 2, to: 3, edge: 102, amount: 0.49 },
      { hop: 3, from: 3, to: 4, edge: 103, amount: 0.34 },
    ];
    expect(pathEdges(flows, 4)).toEqual([103, 102, 101]);
    // The walk starts at the deepest hop and only follows flows landing in the current layer
    // (PRD §10.4): a node strictly inside a longer chain collects nothing — callers pass the
    // recalled node, which is the flow frontier.
    expect(pathEdges(flows, 2)).toEqual([]);
  });

  it("collects every branch that converges on the target and skips unrelated flows", () => {
    const flows: Flow[] = [
      { hop: 1, from: 1, to: 2, edge: 11, amount: 0.35 },
      { hop: 1, from: 3, to: 4, edge: 13, amount: 0.35 },
      { hop: 1, from: 1, to: 99, edge: 19, amount: 0.35 }, // decoy: never on the target's path
      { hop: 2, from: 2, to: 9, edge: 12, amount: 0.24 },
      { hop: 2, from: 4, to: 9, edge: 14, amount: 0.24 },
    ];
    expect(pathEdges(flows, 9)).toEqual([12, 14, 11, 13]);
  });

  it("returns no edges when the target is a cue (cues never receive flow)", () => {
    const flows: Flow[] = [{ hop: 1, from: 1, to: 2, edge: 31, amount: 0.7 }];
    expect(pathEdges(flows, 1)).toEqual([]);
  });

  it("recovers the cue→target path from real spread output", () => {
    const now = DAY;
    const adj = new Map<number, Array<{ id: number; to: number } & EdgeState>>([
      [1, [{ id: 11, to: 2, strength: 1, lastUsedAt: 0, halfLifeClass: "default" }]],
      [2, [{ id: 12, to: 3, strength: 1, lastUsedAt: 0, halfLifeClass: "default" }]],
      [3, [{ id: 13, to: 4, strength: 1, lastUsedAt: 0, halfLifeClass: "default" }]],
    ]);
    const flows = spread({ nodes: new Map(), adj }, [{ id: 1, activation: 1 }], now, P);
    expect(flows).toHaveLength(3);
    expect(pathEdges(flows, 4)).toEqual([13, 12, 11]);
  });
});

describe("score + pathEdges — exposure lane", () => {
  it("reaches a dormant neighbor via spread but leaves it out of the associative rows", () => {
    const now = 100 * DAY;
    // Episode 10 (recalled), dormant detail 20 behind a floor-strength edge, healthy neighbor 30.
    const adj = new Map<number, Array<{ id: number; to: number } & EdgeState>>([
      [1, [{ id: 41, to: 10, strength: 1, lastUsedAt: now, halfLifeClass: "default" }]],
      [
        10,
        [
          { id: 42, to: 20, strength: 0.001, lastUsedAt: now, halfLifeClass: "default" },
          { id: 43, to: 30, strength: 1, lastUsedAt: now, halfLifeClass: "default" },
        ],
      ],
    ]);
    const flows = spread({ nodes: new Map(), adj }, [{ id: 1, activation: 1 }], now, P);

    // Detail 20 is genuinely dormant: one access 10 years old → B ≈ ln(3650^-0.5) ≈ -4.10.
    const detail: NodeState & { kind: Kind } = {
      accessCount: 1,
      recentAccess: [now - 3650 * DAY],
      createdAt: 0,
      kind: "fact",
    };
    expect(isDormantNode(baseLevel(detail, now, P), P)).toBe(true);

    // Spread still reaches the dormant detail: 0.7·0.001·0.7/2 = 0.000245 ≥ ε — the raw material
    // the service's exposure lane (§10.5 step 6) lists it from.
    const to20 = flows.find((f) => f.to === 20);
    expect(to20?.amount).toBeCloseTo(0.000245, 12);

    // Associative rows use S = accumulated flow mass per node (§10.5 step 5).
    const act = new Map<number, number>();
    for (const f of flows) act.set(f.to, (act.get(f.to) ?? 0) + f.amount);
    const nodes: Nodes = new Map([
      [10, { accessCount: 1, recentAccess: [now], createdAt: now, kind: "episode" }],
      [20, detail],
      [30, { accessCount: 1, recentAccess: [now], createdAt: now, kind: "entity" }],
    ]);
    const rows = score(nodes, act, now, P);
    // 20 is gated out of the associative lane (S < minSpread); 10 and 30 rank by A desc.
    expect(rows.map((r) => r.id)).toEqual([10, 30]);

    // pathEdges reconnects the dormant detail back through the episode to the cue layer.
    expect(pathEdges(flows, 20)).toEqual([42, 41]);
  });
});
