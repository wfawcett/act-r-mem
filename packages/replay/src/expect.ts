// Expectation evaluation (E03 task 8, PRD §15.3). Checks Expectations against
// the lane results of the most recent recall and the current node/edge state.
// Failures are collected and returned — this never throws. Each failure names
// the expectation; runScenario fills in scenario and step.
import {
  baseLevel,
  isDormantNode,
  score,
  type Activation,
  type EdgeState,
  type Flow,
  type Params,
  type ScoreRow,
} from '@recall/activation';
import { MemoryStore } from './store.js';
import type { Expectations } from './types.js';
import type { Lane, RecallRow, TraceRecord } from './runner.js';

export interface LaneResults {
  associative: RecallRow[];
  exposure: RecallRow[];
  direct: RecallRow[];
}

export interface ExpectContext {
  store: MemoryStore;
  params: Params;
  now: number;
  lanes: LaneResults;
}

// Expectations bind to the most recent recall step. Because `use` mutates graph
// state (and expectations run after it), lane rows are recomputed from the last
// recall's flows so B/strength values reflect post-use state.
export function lanesOf(
  store: MemoryStore,
  flows: Flow[],
  p: Params,
  now: number,
  trace: TraceRecord | undefined,
): LaneResults {
  if (!trace) return { associative: [], exposure: [], direct: [] };
  const activation: Activation = new Map();
  for (const f of flows) activation.set(f.to, (activation.get(f.to) ?? 0) + f.amount);
  const rows: RecallRow[] = (score(store.nodesView(), activation, now, p) as ScoreRow[]).map((r) => ({
    id: r.id,
    key: store.nodeKey(r.id),
    label: store.nodeLabel(r.id),
    kind: store.nodeKind(r.id),
    lane: 'associative' as const,
    A: r.A,
    B: r.B,
    S: r.S,
  }));
  const byLane = (lane: Lane) => trace.recalled.filter((r) => r.lane === lane).map((r) => r.id);
  return {
    associative: rows,
    exposure: rowsOf(store, byLane('exposure'), 'exposure', now, p),
    direct: rowsOf(store, byLane('direct'), 'direct', now, p),
  };
}

function rowsOf(store: MemoryStore, ids: number[], lane: Lane, now: number, p: Params): RecallRow[] {
  return ids.map((id) => {
    const B = baseLevel(store.nodeState(id), now, p);
    return { id, key: store.nodeKey(id), label: store.nodeLabel(id), kind: store.nodeKind(id), lane, A: B, B, S: 0 };
  });
}

export function evaluateExpectations(ex: Expectations, ctx: ExpectContext): ScenarioFailureLite[] {
  const failures: ScenarioFailureLite[] = [];
  const fail = (expectation: string, detail: string) => failures.push({ expectation, detail });
  const keys = (rows: RecallRow[]) => rows.map((r) => r.key);

  const includes = (list: string[] | undefined, rows: RecallRow[], name: string) => {
    for (const k of list ?? []) {
      if (!rows.some((r) => r.key === k)) fail(name, `expected ${k} in ${name.replace(/_includes$|_is$/, '')} lane results`);
    }
  };
  includes(ex.associative_includes, ctx.lanes.associative, 'associative_includes');
  includes(ex.exposure_includes, ctx.lanes.exposure, 'exposure_includes');

  for (const k of ex.associative_excludes ?? []) {
    if (ctx.lanes.associative.some((r) => r.key === k)) fail('associative_excludes', `${k} must not appear in the associative lane`);
  }
  if (ex.associative_top) {
    const got = keys(ctx.lanes.associative).slice(0, ex.associative_top.length);
    if (got.join('|') !== ex.associative_top.join('|')) {
      fail('associative_top', `expected top ${ex.associative_top.length} [${ex.associative_top.join(', ')}], got [${got.join(', ')}]`);
    }
  }
  if (ex.direct_is) {
    const got = keys(ctx.lanes.direct);
    if (got.join('|') !== ex.direct_is.join('|')) {
      fail('direct_is', `expected direct lane [${ex.direct_is.join(', ')}], got [${got.join(', ')}]`);
    }
  }
  for (const k of ex.none_of ?? []) {
    const lanes = (['associative', 'exposure', 'direct'] as const).filter((l) => ctx.lanes[l].some((r) => r.key === k));
    if (lanes.length > 0) fail('none_of', `${k} appeared in lanes: ${lanes.join(', ')}`);
  }

  for (const [i, n] of (ex.node ?? []).entries()) {
    const id = ctx.store.resolveKey(n.key);
    if (id === undefined) {
      fail(`node[${i}]`, `unknown node key: ${n.key}`);
      continue;
    }
    const B = baseLevel(ctx.store.nodeState(id), ctx.now, ctx.params);
    const dormant = isDormantNode(B, ctx.params);
    if (n.dormant !== undefined && dormant !== n.dormant) {
      fail(`node[${i}].dormant`, `${n.key} should be ${n.dormant ? 'dormant' : 'active'} (P below dormantP), B=${fmt(B)}`);
    }
    if (n.active !== undefined && dormant === n.active) {
      fail(`node[${i}].active`, `${n.key} should be ${n.active ? 'active' : 'dormant'}, B=${fmt(B)}`);
    }
    if (n.B_gt !== undefined && !(B > n.B_gt)) fail(`node[${i}].B_gt`, `${n.key} B=${fmt(B)} not > ${n.B_gt}`);
    if (n.B_lt !== undefined && !(B < n.B_lt)) fail(`node[${i}].B_lt`, `${n.key} B=${fmt(B)} not < ${n.B_lt}`);
  }

  for (const [i, e] of (ex.edge ?? []).entries()) {
    const from = ctx.store.resolveKey(e.from);
    const to = ctx.store.resolveKey(e.to);
    if (from === undefined || to === undefined) {
      fail(`edge[${i}]`, `unknown edge endpoints: ${e.from}->${e.to}`);
      continue;
    }
    let state: EdgeState;
    try {
      state = ctx.store.edgeState(from, to);
    } catch {
      fail(`edge[${i}]`, `no edge ${e.from}->${e.to}`);
      continue;
    }
    if (e.strength_gt !== undefined && !(state.strength > e.strength_gt)) {
      fail(`edge[${i}].strength_gt`, `${e.from}->${e.to} strength=${fmt(state.strength)} not > ${e.strength_gt}`);
    }
    if (e.strength_lt !== undefined && !(state.strength < e.strength_lt)) {
      fail(`edge[${i}].strength_lt`, `${e.from}->${e.to} strength=${fmt(state.strength)} not < ${e.strength_lt}`);
    }
  }
  return failures;
}

// Failure without the scenario/step fields runScenario attaches.
export interface ScenarioFailureLite {
  expectation: string;
  detail: string;
}

const fmt = (x: number): string => (Number.isFinite(x) ? x.toFixed(4) : String(x));
