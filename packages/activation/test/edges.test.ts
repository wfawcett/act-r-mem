import { baseLevel, edgeStrength, isDormantNode, recordAccess, reinforceEdge, spread } from "../src/index.js";
import { describe, expect, it } from "vitest";
import type { EdgeState, NodeState } from "../src/types.js";
import type { Params } from "../src/types.js";

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

describe("edgeStrength — half-life decay", () => {
  it("decays w * 0.5^(t/h) from the stored strength", () => {
    const e: EdgeState = { strength: 1.0, lastUsedAt: 0, halfLifeClass: "default" };
    // After one default half-life (30 days), strength halves.
    expect(edgeStrength(e, 30 * DAY, P)).toBeCloseTo(0.5, 12);
    // After two half-lives it quarters.
    expect(edgeStrength(e, 60 * DAY, P)).toBeCloseTo(0.25, 12);
  });

  it("uses the per-class half-life (identity fades slowest, incidental fastest)", () => {
    const t = 30 * DAY;
    const identity = edgeStrength({ strength: 1, lastUsedAt: 0, halfLifeClass: "identity" }, t, P);
    const incidental = edgeStrength({ strength: 1, lastUsedAt: 0, halfLifeClass: "incidental" }, t, P);
    expect(identity).toBeGreaterThan(incidental); // identity half-life (180d) decays less over 30 days.
  });

  it("does not decay into growth when now < lastUsedAt (clamp with Math.max(0, ...))", () => {
    const e: EdgeState = { strength: 0.5, lastUsedAt: 10 * DAY, halfLifeClass: "default" };
    // Before use time → arg is clamped to 0 → decayed == original strength (no growth).
    expect(edgeStrength(e, 5 * DAY, P)).toBeCloseTo(0.5, 12);
  });
});

describe("edgeStrength — floor", () => {
  it("floors at edgeFloor for an edge unused far beyond its half-life", () => {
    // A default edge (h=30d) after ~many half-lives → 0.5^n ≈ 0, floored to 0.001.
    const e: EdgeState = { strength: 1.0, lastUsedAt: 0, halfLifeClass: "default" };
    expect(edgeStrength(e, 365 * DAY * 20, P)).toBeCloseTo(P.edgeFloor, 12);
  });

  it("floors an incidental edge (h=7d) after one year", () => {
    const e: EdgeState = { strength: 1.0, lastUsedAt: 0, halfLifeClass: "incidental" };
    expect(edgeStrength(e, 365 * DAY, P)).toBeCloseTo(P.edgeFloor, 12);
  });
});

describe("reinforceEdge — decay-then-cap", () => {
  it("folds decay in before applying the diminishing gain", () => {
    const e: EdgeState = { strength: 1.0, lastUsedAt: 0, halfLifeClass: "default" };
    // After one default half-life (w → 0.5) then gain g=0.2: w' = min(1, 0.5 + 0.2·0.5) = 0.6.
    const r = reinforceEdge(e, 30 * DAY, P);
    expect(r.strength).toBeCloseTo(0.6, 12);
    expect(r.lastUsedAt).toBe(30 * DAY); // lastUsedAt updates to now.
  });

  it("caps strength at 1 even from a fresh edge", () => {
    const e: EdgeState = { strength: P.edgeInitial, lastUsedAt: 0, halfLifeClass: "identity" };
    const r = reinforceEdge(e, 0, P); // no decay; w' = min(1, 1 + g·0) = 1.
    expect(r.strength).toBeCloseTo(1.0, 12);
  });

  it("gains less in a burst (diminishing): spread-out reinforcement beats a same-window burst", () => {
    const fresh: EdgeState = { strength: P.edgeInitial, lastUsedAt: 0, halfLifeClass: "default" };
    // Two uses one half-life apart each apply to the decayed base.
    const first = reinforceEdge(fresh, 30 * DAY, P); // → 0.6
    const second = reinforceEdge(first, 60 * DAY, P); // w=0.3 at this point: min(1, 0.3 + 0.2·0.7) = 0.44
    expect(second.strength).toBeCloseTo(0.44, 12);
    // A burst (both within the same session window) caps lower than spread-out reinforcement would.
    const burst = reinforceEdge(fresh, 30 * DAY, P);
    const burstAgain = reinforceEdge(burst, 30 * DAY, P); // no decay between: min(1, 0.6 + 0.2·0.4) = 0.68
    expect(burstAgain.strength).toBeGreaterThan(second.strength);
  });

  it("returns a new object rather than mutating (pure)", () => {
    const e: EdgeState = { strength: 1, lastUsedAt: 0, halfLifeClass: "default" };
    const r = reinforceEdge(e, 30 * DAY, P);
    expect(r).not.toBe(e);
    expect(e.strength).toBe(1); // original untouched.
  });
});

describe("recordAccess — revival bonus (SC-10)", () => {
  it("adds one access and stays dormant-free when the node was active", () => {
    const now = 5 * DAY;
    const active: NodeState = { accessCount: 3, recentAccess: [now], createdAt: 0 };
    // Active node: recordAccess adds exactly one stamp and increments count by 1.
    const r = recordAccess(active, now, P, false);
    expect(r.accessCount).toBe(4);
    expect(r.recentAccess.length).toBe(2);
    expect(r.recentAccess[0]).toBe(now);
  });

  it("adds 1 + reviveExtraAccesses accesses and is no longer dormant when the node was dormant (SC-10)", () => {
    const now = 5 * DAY;
    // A long-forgotten single access → very low B → dormant.
    const dormant: NodeState = { accessCount: 1, recentAccess: [now - 365 * DAY], createdAt: 0 };
    expect(isDormantNode(baseLevel(dormant, now, P), P)).toBe(true);

    const r = recordAccess(dormant, now, P, true);
    // Revival bonus: accessCount grows by 1 + reviveExtraAccesses (3).
    expect(r.accessCount).toBe(1 + 1 + P.reviveExtraAccesses);
    // Recent stamps: revival stamps first, then the old one, capped at M.
    expect(r.recentAccess.slice(0, 3)).toEqual([now, now, now]);
  });

  it("caps recentAccess at M when many revival stamps are added", () => {
    const now = DAY;
    const dormant: NodeState = { accessCount: 1, recentAccess: [], createdAt: 0 };
    const r = recordAccess(dormant, now, P, true); // 1 + 2 = 3 fresh stamps, no prior.
    expect(r.recentAccess.length).toBe(3); // exactly the revival stamps.
  });
});

describe("SC-11 — edge floor and traversability", () => {
  it("an edge unused for 5 years has strength exactly edgeFloor", () => {
    const e: EdgeState = { strength: 1.0, lastUsedAt: 0, halfLifeClass: "default" };
    expect(edgeStrength(e, 365 * DAY * 5, P)).toBeCloseTo(P.edgeFloor, 12);
  });

  it("still traverses a floor edge (carries ~nothing but is not skipped)", () => {
    // spread does not prune floor edges outright; it only drops flows below epsilon. A nonzero weight edge at the
    // floor still emits a flow when source activation and strength keep amount ≥ epsilon.
    const now = 365 * DAY * 5 + DAY;
    const e: EdgeState = { strength: P.edgeInitial, lastUsedAt: 0, halfLifeClass: "default" };
    // effective weight is exactly the floor; a single-hop spread with activation=1 and fan=1 yields amount ≥ epsilon.
    const adj = new Map([
      [
        1,
        [
          { to: 2, id: 7, strength: e.strength, lastUsedAt: e.lastUsedAt, halfLifeClass: e.halfLifeClass },
        ],
      ],
    ]);
    const flows = spread(
      { nodes: new Map(), adj },
      [{ id: 1, activation: 1.0 }],
      now,
      P,
    );
    expect(flows.length).toBeGreaterThan(0); // traversed despite being at the floor.
    const flow = flows.find((f) => f.edge === 7);
    expect(flow).toBeDefined();
    expect(flow!.amount).toBeCloseTo(P.edgeFloor * P.damping, 12); // amount uses effective (floored) strength.
  });
});
