// Scenario runner for the replay harness (E03 task 6, PRD §10.5/§15.2). Injected
// clock, stub embedder (declared similarities instead of vectors), and the
// recall pipeline steps 4–8 in memory. No randomness, no Date.now().
//
// NOTE: expectation evaluation still lives here and is lifted into `expect.ts`
// (task 8); the shapes below are the stable contracts that task consumes.
import {
  baseLevel,
  isDormantNode,
  score,
  spread,
  type Activation,
  type Cue,
  type Flow,
  type Kind,
  type Nodes,
  type Params,
  type ScoreRow,
} from '@recall/activation';
import type { EdgeState } from '@recall/activation';
import type { Expectations, RecallAction, RememberInput, Scenario, ScenarioEdge, ScenarioNode } from './types.js';
import { defaultParams, mergeParams } from './params.js';
import { serializeTrace, type TraceRecord } from './trace.js';
import { MemoryStore } from './store.js';

const DAY = 86_400_000;

// --- Injected clock -----------------------------------------------------------

export interface InjectedClock {
  /** Scenario-relative day offset; `nowMs = epochMs + at * DAY`. */
  at: number;
  readonly epochMs: number;
  nowMs(): number;
  advance(days: number): void;
}

export function createClock(epochMs: number, at = 0): InjectedClock {
  const clock: InjectedClock = {
    at,
    epochMs,
    nowMs: () => epochMs + clock.at * DAY,
    advance(days) {
      clock.at += days;
    },
  };
  return clock;
}

// --- Recall outcome / lane rows -------------------------------------------------

// Lane rows moved to expect.ts (task 8).
import {
  evaluateExpectations,
  lanesOf,
  type ExpectContext,
  type LaneResults,
} from './expect.js';

export type Lane = 'associative' | 'exposure' | 'direct';

export interface RecallRow {
  id: number;
  key: string;
  label: string;
  kind: Kind;
  lane: Lane;
  A: number;
  B: number;
  S: number;
  /** Exposure lane only: the episode id this row was reached through. */
  via?: number;
  /** Direct lane only: declared similarity from the stub embedder. */
  sim?: number;
}

export interface RecallOutcome {
  cues: Cue[];
  flows: Flow[];
  associative: RecallRow[];
  exposure: RecallRow[];
  direct: RecallRow[];
  recalled: RecallRow[];
  usedIds: number[];
  /** Distinct nodes pulled into the neighborhood (cap: params.maxExpanded). */
  expanded: number;
  durationMs: number;
  // recall_trace header fields (§7), taken from the recall action verbatim.
  tenant_id: string;
  session_id: string;
  client: string;
  query: string;
}

// §7 recall_trace record lives in trace.ts (task 7).
export type { TraceRecord } from './trace.js';

// --- Failures / result ------------------------------------------------------------

export interface ScenarioFailure {
  scenario: string;
  step: number; // 1-based step index
  expectation: string;
  detail: string;
}

export interface ScenarioResult {
  passed: boolean;
  failures: ScenarioFailure[];
  traces: TraceRecord[];
}

export interface SetupFixture {
  nodes?: ScenarioNode[];
  edges?: ScenarioEdge[];
}

export interface RunOptions {
  epochMs?: number;
  /** Fixture hook for `setup:` scenarios (SC-15); resolved by the runner. */
  setup?: (name: string) => SetupFixture;
}

export function runScenario(scenario: Scenario, opts: RunOptions = {}): ScenarioResult {
  const failures: ScenarioFailure[] = [];
  const traces: TraceRecord[] = [];
  const params = mergeParams(defaultParams(), (scenario.params ?? {}) as Partial<Params>);
  const clock = createClock(opts.epochMs ?? 0);
  const store = new MemoryStore(params, clock.epochMs);

  const fail = (step: number, expectation: string, detail: string) => {
    failures.push({ scenario: scenario.name, step, expectation, detail });
  };

  // Setup fixture hook (SC-15 scale seed), applied before the graph/steps.
  if (scenario.setup) {
    const fixture = opts.setup?.(scenario.setup);
    if (!fixture) fail(0, 'setup', `no fixture registered for setup "${scenario.setup}"`);
    for (const n of fixture?.nodes ?? []) store.upsertNode(n);
    for (const e of fixture?.edges ?? []) store.upsertEdge(e);
  }
  for (const n of scenario.nodes) store.upsertNode(n);
  for (const e of scenario.edges) store.upsertEdge(e);

  let lastRecall: { trace: TraceRecord; flows: Flow[] } | undefined;

  for (const [i, step] of scenario.steps.entries()) {
    const stepNo = i + 1;
    try {
      clock.at = step.at;
      if (step.advance) clock.advance(step.advance);
      const now = clock.nowMs();

      if (step.recall) {
        const outcome = runRecall(store, params, now, step.recall);
        const trace = serializeTrace(outcome, clock, params);
        traces.push(trace);
        lastRecall = { trace, flows: outcome.flows };
      }

      if (step.remember) {
        store.rememberStructured(step.remember, now);
      }

      if (step.use) {
        if (!lastRecall) {
          fail(stepNo, 'use', 'no prior recall to reinforce along');
        } else {
          const ids = step.use.map((k) => store.resolveKey(k)).map((id) => id ?? -1);
          const unknown = step.use.filter((k) => store.resolveKey(k) === undefined);
          if (unknown.length > 0) {
            fail(stepNo, 'use', `unknown use keys: ${unknown.join(', ')}`);
          }
          // §10.6 flush semantics: reinforce inline along the last trace's paths.
          store.setLastFlows(lastRecall.flows);
          store.applyUse(ids.filter((id) => id >= 0), now, params);
          for (const id of ids) {
            if (id >= 0 && !lastRecall.trace.used_ids.includes(id)) lastRecall.trace.used_ids.push(id);
          }
        }
      }
    } catch (err) {
      fail(stepNo, 'run', err instanceof Error ? err.message : String(err));
    }

    if (step.expect) {
      const now = clock.nowMs();
      const ctx: ExpectContext = {
        store,
        params,
        now,
        lanes: lastRecall
          ? lanesOf(store, lastRecall.flows, params, now, traces[traces.length - 1])
          : { associative: [], exposure: [], direct: [] },
      };
      for (const f of evaluateExpectations(step.expect, ctx)) failures.push({ ...f, scenario: scenario.name, step: stepNo });
    }
  }

  return { passed: failures.length === 0, failures, traces };
}


// --- Recall pipeline (§10.5 steps 4–8) ------------------------------------------------

interface StubCues {
  cues: Cue[];
  sims: Map<number, number>; // node id -> declared similarity (direct lane)
}

function buildCues(store: MemoryStore, p: Params, action: RecallAction): StubCues {
  const cues = new Map<number, Cue>();
  const sims = new Map<number, number>();
  for (const key of action.cues ?? []) {
    const id = store.resolveKey(key);
    if (id === undefined) throw new Error(`unknown cue: ${key}`);
    cues.set(id, { id, activation: 1.0 }); // explicit cues weigh 1.0 (§10.5 step 3)
  }
  const declared = Object.entries(action.similar ?? {})
    .map(([key, sim]) => ({ id: store.resolveKey(key), key, sim }))
    .filter((e): e is { id: number; key: string; sim: number } => e.id !== undefined)
    .sort((a, b) => b.sim - a.sim || a.key.localeCompare(b.key)); // deterministic tie-break
  let seeds = 0;
  for (const d of declared) {
    sims.set(d.id, d.sim);
    if (seeds >= p.seedK || d.sim < p.seedMinSim || cues.has(d.id)) continue;
    cues.set(d.id, { id: d.id, activation: d.sim }); // weight = sim (§10.5 step 3)
    seeds++;
  }
  return { cues: [...cues.values()], sims };
}

// Neighborhood load with the maxExpanded node-expansion cap (count nodes, not
// flows — §10.3). Invalidated nodes/edges (SC-12) are never loaded.
function loadNeighborhood(store: MemoryStore, cueIds: number[], p: Params): { adj: Map<number, Array<{ id: number; to: number } & EdgeState>>; expanded: number } {
  const inGraph = new Set(cueIds);
  let frontier = [...cueIds];
  let expanded = 0;
  let capped = false;
  for (let hop = 0; hop < p.hops && frontier.length > 0 && !capped; hop++) {
    const next: number[] = [];
    for (const u of frontier) {
      for (const e of store.adj.get(u) ?? []) {
        if (capped) break;
        const v = e.to;
        if (inGraph.has(v) || store.isInvalidated(v) || store.isEdgeInvalidated(e.id)) continue;
        if (expanded >= p.maxExpanded) {
          capped = true;
          break;
        }
        inGraph.add(v);
        expanded++;
        next.push(v);
      }
      if (capped) break;
    }
    frontier = next;
  }
  const adj = new Map<number, Array<{ id: number; to: number } & EdgeState>>();
  for (const u of inGraph) {
    const list = (store.adj.get(u) ?? []).filter((e) => inGraph.has(e.to) && !store.isEdgeInvalidated(e.id));
    if (list.length > 0) adj.set(u, list);
  }
  return { adj, expanded };
}

function runRecall(store: MemoryStore, p: Params, now: number, action: RecallAction): RecallOutcome {
  const { cues, sims } = buildCues(store, p, action);
  const cueIds = cues.map((c) => c.id);

  // Steps 4–5: capped neighborhood load, then spread + score over the subgraph.
  const { adj, expanded } = loadNeighborhood(store, cueIds, p);
  const graph = { nodes: store.nodesView() as Nodes, adj };
  const flows = spread(graph, cues, now, p);
  const activation: Activation = new Map();
  for (const f of flows) activation.set(f.to, (activation.get(f.to) ?? 0) + f.amount);

  const associative: RecallRow[] = score(graph.nodes, activation, now, p).map((r) => ({
    id: r.id,
    key: store.nodeKey(r.id),
    label: store.nodeLabel(r.id),
    kind: store.nodeKind(r.id),
    lane: 'associative' as const,
    A: r.A,
    B: r.B,
    S: r.S,
  }));
  const recalled = [...associative];
  const seen = new Set(recalled.map((r) => r.id));

  // Step 6: exposure lane — every valid neighbor of a recalled episode, dormant
  // included, via = the episode id.
  const exposure: RecallRow[] = [];
  for (const row of associative) {
    if (row.kind !== 'episode') continue;
    for (const e of store.adj.get(row.id) ?? []) {
      if (seen.has(e.to) || store.isInvalidated(e.to) || store.isEdgeInvalidated(e.id)) continue;
      seen.add(e.to);
      const B = baseLevel(store.nodeState(e.to), now, p);
      exposure.push({
        id: e.to,
        key: store.nodeKey(e.to),
        label: store.nodeLabel(e.to),
        kind: store.nodeKind(e.to),
        lane: 'exposure',
        A: B,
        B,
        S: 0,
        via: row.id,
      });
    }
  }
  recalled.push(...exposure);

  // Step 7: direct lane — best declared similarity over fact nodes, gated at
  // directMinSim, skipped when already present.
  const direct: RecallRow[] = [];
  if (action.query !== undefined) {
    const facts = [...sims.entries()]
      .filter(([id, sim]) => sim >= p.directMinSim && store.nodeKind(id) === 'fact' && !store.isInvalidated(id))
      .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const top = facts[0];
    if (top && !seen.has(top[0])) {
      const id = top[0];
      const B = baseLevel(store.nodeState(id), now, p);
      direct.push({
        id,
        key: store.nodeKey(id),
        label: store.nodeLabel(id),
        kind: store.nodeKind(id),
        lane: 'direct',
        A: B,
        B,
        S: 0,
        sim: top[1],
      });
      seen.add(id);
    }
  }
  recalled.push(...direct);

  return {
    cues,
    flows,
    associative,
    exposure,
    direct,
    recalled,
    usedIds: [],
    expanded,
    durationMs: durationMs(flows),
    tenant_id: 'local',
    session_id: action.session_id ?? 'replay',
    client: action.client ?? 'omp',
    query: action.query ?? '',
  };
}

// duration_ms derives from the injected pipeline shape, never the wall clock:
// 8ms base plus 4ms per hop that produced flows (1–3 hops in practice).
function durationMs(flows: Flow[]): number {
  const maxHop = flows.reduce((m, f) => Math.max(m, f.hop), 0);
  return 8 + 4 * maxHop;
}

// --- Trace assembly lives in trace.ts (task 7); runner consumes serializeTrace.
