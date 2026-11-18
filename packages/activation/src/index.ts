/**
 * Pure ACT-R declarative-memory math (PRD §10.1–10.4). E02 fills this package.
 * Invariants (PRD §2.3): no I/O, no randomness, no Date.now() — `now` is always a parameter.
 */
import type { Activation, Cue, EdgeState, Flow, Graph, Kind, Nodes, Params, ScoreRow } from "./types.js";

export const DAY = 86_400_000;

// §10.1 base level with the Petrov hybrid tail term for unstored older accesses. When there are
// no stored traces (m == 0) the recent-term sum is empty, so log(0) → -Infinity; report Infinity
// to signal "no stored memory".
export function baseLevel(n: NodeState, now: number, p: Params): number {
  const ages = n.recentAccess.map((t) => Math.max((now - t) / DAY, p.minAgeDays));
  let sum = 0;
  for (const a of ages) sum += Math.pow(a, -p.decay);
  const m = ages.length;
  const rest = n.accessCount - m;
  if (rest > 0 && m > 0) {
    const L = Math.max((now - n.createdAt) / DAY, p.minAgeDays);
    const tm = ages[m - 1];
    if (L - tm >= p.minAgeDays) {
      const k = 1 - p.decay;
      sum += (rest * (Math.pow(L, k) - Math.pow(tm, k))) / (k * (L - tm));
    }
  }
  return sum === 0 ? Number.POSITIVE_INFINITY : Math.log(sum);
}

export function recallProbability(B: number, p: Params): number {
  return 1 / (1 + Math.exp(-(B - p.tau) / p.noiseScale));
}

export function isDormantNode(B: number, p: Params): boolean {
  return recallProbability(B, p) < p.dormantP;
}

// §10.2 edge strength with half-life decay floored at edgeFloor.
export function edgeStrength(e: EdgeState, now: number, p: Params): number {
  const h = p.halfLifeDays[e.halfLifeClass];
  const decayed = e.strength * Math.pow(0.5, Math.max(0, now - e.lastUsedAt) / DAY / h);
  return Math.max(p.edgeFloor, decayed);
}

export function reinforceEdge(e: EdgeState, now: number, p: Params): EdgeState {
  const w = edgeStrength(e, now, p);
  return { ...e, strength: Math.min(1, w + p.edgeGain * (1 - w)), lastUsedAt: now };
}

export function recordAccess(n: NodeState, now: number, p: Params, wasDormant: boolean): NodeState {
  const extra = wasDormant ? p.reviveExtraAccesses : 0;
  const stamps = Array(1 + extra).fill(now);
  return {
    ...n,
    accessCount: n.accessCount + 1 + extra,
    recentAccess: [...stamps, ...n.recentAccess].slice(0, p.recentAccesses),
  };
}

// §10.3 spreading activation over an undirected adjacency map. Cues never receive activation;
// frontier is ordered by activation desc then id asc; flows below pruneEpsilon are pruned and at
// most maxExpanded total flows are emitted. `amount` uses the effective (floored) edge strength
// divided across fan, per PRD §10.3 line 708.
export function spread(g: Graph, cues: Cue[], now: number, p: Params): Flow[] {
  const cueIds = new Set(cues.map((c) => c.id));
  const flows: Flow[] = [];
  let frontier = new Map<number, number>(cues.map((c) => [c.id, c.activation]));
  for (let hop = 1; hop <= p.hops && frontier.size > 0; hop++) {
    const next = new Map<number, number>();
    const sources = [...frontier.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    for (const [u, act] of sources) {
      const list = g.adj.get(u) ?? [];
      const fan = list.length;
      for (const e of list) {
        if (cueIds.has(e.to)) continue;
        const amount = (act * edgeStrength(e, now, p) * p.damping) / fan;
        if (amount < p.pruneEpsilon) continue;
        next.set(e.to, (next.get(e.to) ?? 0) + amount);
        if (flows.length >= p.maxExpanded) return flows;
        flows.push({ hop, from: u, to: e.to, edge: e.id, amount });
      }
    }
    frontier = next;
  }
  return flows;
}

// §10.4 associative-lane scoring: gates on spread mass and total activation, sorted by
// activation desc then id asc, limited to resultLimit. `pathEdges` walks flows backwards from a
// target collecting the edge ids that connect it back to the cue layer.
export function score(nodes: Nodes, activation: Activation, now: number, p: Params): ScoreRow[] {
  const out: ScoreRow[] = [];
  for (const [id, S] of activation) {
    const n = nodes.get(id);
    if (!n || S < p.minSpread) continue;
    const B = baseLevel(n, now, p);
    const A = B + p.spreadWeight * S;
    if (A >= p.recallThreshold) out.push({ id, A, B, S });
  }
  return out.sort((x, y) => y.A - x.A || x.id - y.id).slice(0, p.resultLimit);
}

export function pathEdges(flows: Flow[], target: number): number[] {
  const edges: number[] = [];
  let layer = new Set([target]);
  for (let hop = Math.max(0, ...flows.map((f) => f.hop)); hop >= 1; hop--) {
    const prev = new Set<number>();
    for (const f of flows) if (f.hop === hop && layer.has(f.to)) edges.push(f.edge);
    for (const x of layer) for (const f of flows) if (f.hop === hop && f.to === x) prev.add(f.from);
    layer = prev;
  }
  return edges;
}

interface NodeState {
  accessCount: number;
  recentAccess: number[]; // epoch ms, newest first, at most M
  createdAt: number; // epoch ms
}
