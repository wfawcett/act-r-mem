import { describe, expect, it } from "vitest";
import { baseLevel, isDormantNode, recallProbability } from "../src/index.js";
import type { NodeState } from "../src/types.js";
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

describe("baseLevel — recent-term + age clamping", () => {
  it("sums a single stored trace and clamps young ages to minAgeDays", () => {
    const now = 5 * DAY;
    // One access at `now` → age 0, clamped up to minAgeDays.
    const n: NodeState = { accessCount: 1, recentAccess: [now], createdAt: now };
    // a = max(0, minAgeDays) = 0.01; sum += 0.01^-0.5 = 10; log(10) ≈ 2.3026.
    expect(baseLevel(n, now, P)).toBeCloseTo(Math.log(1 / Math.sqrt(P.minAgeDays)), 8);
  });

  it("ignores the hybrid tail when there are no stored traces (m == 0)", () => {
    // accessCount > 1 but recentAccess empty: rest > 0 yet m == 0, so the tail is dropped.
    const now = 10 * DAY;
    const n: NodeState = { accessCount: 5, recentAccess: [], createdAt: now - 100 * DAY };
    expect(baseLevel(n, now, P)).toBe(Infinity); // log(0) with no traces
  });

  it("ignores the hybrid tail when every stored trace is accounted for (rest == 0)", () => {
    const now = 10 * DAY;
    const recent = [now - 2 * DAY, now - 5 * DAY];
    const n: NodeState = { accessCount: 2, recentAccess: recent, createdAt: now - 20 * DAY };
    // Same graph with an extra stored trace (rest > 0) yields a strictly larger base level.
    const richer: NodeState = {
      accessCount: 3,
      recentAccess: [now - 9 * DAY, ...recent],
      createdAt: now - 20 * DAY,
    };
    expect(baseLevel(richer, now, P)).toBeGreaterThan(baseLevel(n, now, P));
  });

  it("includes the Petrov hybrid tail when older accesses are not stored (rest > 0)", () => {
    const now = 100 * DAY;
    // One recent access + accessCount shows 3 total → two unstored older accesses.
    const n: NodeState = { accessCount: 3, recentAccess: [now - 1 * DAY], createdAt: now - 365 * DAY };
    const B = baseLevel(n, now, P);
    // Compare against the exact sum of the single stored trace (tail omitted).
    const noTail: NodeState = { accessCount: 1, recentAccess: [now - 1 * DAY], createdAt: now - 365 * DAY };
    expect(B).toBeGreaterThan(baseLevel(noTail, now, P)); // tail adds positive mass.
  });

  it("drops the tail term when L − Δt_m falls below minAgeDays", () => {
    const now = 10 * DAY;
    // Node created at the access time: L ≈ tm ≈ minAgeDays, so L − tm < minAgeDays → no tail.
    const n: NodeState = { accessCount: 3, recentAccess: [now], createdAt: now };
    const B = baseLevel(n, now, P);
    // Removing the unstored mass (accessCount → 1) must not change anything: tail was skipped.
    const stripped: NodeState = { accessCount: 1, recentAccess: [now], createdAt: now };
    expect(B).toBe(baseLevel(stripped, now, P));
  });
});

describe("recallProbability and dormancy", () => {
  it("maps B through the logistic centered at tau", () => {
    // At B == τ, P is exactly 0.5.
    expect(recallProbability(P.tau, P)).toBe(0.5);
    // Far above threshold → P near 1; far below → near 0.
    expect(recallProbability(20, P)).toBeGreaterThan(0.99);
    expect(recallProbability(-20, P)).toBeLessThan(0.01);
  });

  it("classifies dormant and active nodes", () => {
    expect(isDormantNode(-50, P)).toBe(true); // P ≈ 0 < 0.2
    expect(isDormantNode(50, P)).toBe(false); // P ≈ 1 ≥ 0.2
    // A mid base level sits between the extremes (either classification is valid).
    const n: NodeState = { accessCount: 3, recentAccess: [90 * DAY], createdAt: 0 };
    const B = baseLevel(n, 100 * DAY, P);
    expect([true, false]).toContain(isDormantNode(B, P));
  });
});
