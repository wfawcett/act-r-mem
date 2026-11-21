# Implementation Plan — E03 Replay harness and scenario suite (card #12)

Spec: `specs/12-e03-replay-harness-and-scenario-suite.md`. Existing code: `packages/activation` exports pure math (`DAY`, `baseLevel`, `recallProbability`, `isDormantNode`, `edgeStrength`, `reinforceEdge`, `spread`/`score` pipeline types `Cue`, `Graph`, `Nodes`, `Params`) with no I/O; `apps/service/src/config.ts` exports `ParamSchema` + `Params` with no pg/env coupling; `config/params.json` holds §4.5 defaults.

## 1. Task list (ordered)

1. Create `packages/replay/package.json` (`@recall/replay`, `"type":"module"`, deps `yaml`, `zod`, `@recall/activation` `workspace:*`; devDep `vitest`; script `test: vitest run`).
   DONE: Create packages/replay/package.json (@recall/replay, type module, deps yaml/zod/@recall/activation workspace:*, devDep vitest, script test: vitest run)
2. Add root script `"replay": "pnpm --filter @recall/replay test"` to `package.json` (workspace globs already cover `packages/*`).
   DONE: Add root script "replay": "pnpm --filter @recall/replay test" to package.json
3. Write `packages/replay/src/types.ts` — zod schemas + inferred types for the §15.2 scenario YAML, `Expectations`, and the §7 `recall_trace`-shaped trace record.
   DONE: Write packages/replay/src/types.ts (zod schemas + inferred types for §15.2 scenario YAML, Expectations, strict unknown-key rejection)
4. Write `packages/replay/src/params.ts` — `defaultParams()` reading `config/params.json`, validating with `ParamSchema` from `apps/service/src/config.ts`; shallow merge scenario `params` over it.
   DONE: Write packages/replay/src/params.ts (defaultParams from config/params.json via ParamSchema, shallow mergeParams)
5. Write `packages/replay/src/store.ts` — `MemoryStore` (Map-based graph mirroring `Graph`/`Nodes`), key→id registry, label/alias resolution, `invalidated` flags (superseded facts excluded from every lane, SC-12), `applyUse(ids, now, p)` applying `recordAccess` + `reinforceEdge` inline along last-trace `pathEdges` (§10.6 flush semantics).
   DONE: Write packages/replay/src/store.ts (MemoryStore, key/label/alias registry, invalidated superseded facts SC-12, inline applyUse flush along last-trace pathEdges)
6. Write `packages/replay/src/runner.ts` — `runScenario(scenario)`: injected clock (`now = epoch + at * DAY`, `advance` moves clock only), stub embedder (explicit cues activation 1.0; declared `similar` sims become `Cue`s, seeds = top `seedK` sims ≥ `seedMinSim`), in-memory recall pipeline §10.5 steps 4–8 with the `maxExpanded` node-expansion cap (count nodes, not flows), spread/score/exposure lane (episode neighbors, dormant included, `via` = episode id)/direct lane (`directMinSim` gate, skipped if already present); `remember` structured upserts with contradiction only via scenario `structured` (no LLM judge).
   DONE: Write packages/replay/src/runner.ts (runScenario: injected clock, stub embedder seeds, §10.5 steps 4–8 with maxExpanded node cap, exposure/direct lanes, inline §10.6 use flush, §7 trace assembly)
7. Write `packages/replay/src/trace.ts` — serialize each recall as the `recall_trace` record (`tenant_id`, `session_id`, `client`, `at`, `query`, `cue_ids`, `cue_weights`, `hops` (prune `amount >= 0.004`), `recalled`, `used_ids`, `params`, `duration_ms`, `expanded`) with stable key ordering, `duration_ms` from injected clock, no wall clock.
   DONE: Write packages/replay/src/trace.ts (§7 recall_trace serialization, stable key ordering, injected-clock duration_ms, writeTraceFile)
8. Write `packages/replay/src/expect.ts` — evaluate `Expectations` (associative includes/excludes/top, exposure includes, direct is, none_of, node dormant/active/B bounds, edge strength bounds) against lane results and node/edge state (dormancy via `recallProbability`/`isDormantNode`); collect failures named scenario+step+expectation, never throw.
   DONE: Write packages/replay/src/expect.ts (evaluateExpectations over lane results and node/edge state via recallProbability/isDormantNode, failures collected not thrown)
9. Write `scenarios/sc-01.yaml`..`sc-15.yaml` — one per PRD §15.3 row; SC-01 = exact §15.2 example graph; SC-02 = 40-episode fan enumerated in YAML; SC-13 = tail approximation asserted with `node: {B_gt, B_lt}` bounds; SC-15 = 50k-node scale scenario using the `setup` fixture hook.
10. Write `packages/replay/test/fixtures/sc-15-seed.ts` — programmatic generator for the 50k-node SC-15 setup (only fixture hook).
11. Write `packages/replay/test/replay.test.ts` — glob every `scenarios/*.yaml`, assert SC-01..SC-15 present exactly once, run each, write `out/traces/<scenario>/<step>.json`, assert pass and `expanded <= maxExpanded`.
12. Write `packages/replay/test/determinism.test.ts` — run the suite twice into two temp dirs, assert byte-identical files.

## 2. Types and interfaces

```ts
// packages/replay/src/types.ts
export interface ScenarioNode { key: string; kind: Kind; label: string; accesses: number[]; created: number; }
export interface ScenarioEdge { from: string; to: string; predicate: string; strength: number; lastUsed: number; }
export interface ScenarioStep {
  at: number;
  recall?: { cues?: string[]; query?: string; similar?: Record<string, number> };
  use?: string[];
  remember?: RememberInput;          // structured only
  advance?: number;                  // days
  expect?: Expectations;
}
export interface Expectations {
  associative_includes?: string[]; associative_excludes?: string[]; associative_top?: string[];
  exposure_includes?: string[]; direct_is?: string[]; none_of?: string[];
  node?: { key: string; dormant?: boolean; active?: boolean; B_gt?: number; B_lt?: number }[];
  edge?: { from: string; to: string; strength_gt?: number; strength_lt?: number }[];
}
export const ScenarioSchema: z.ZodType<Scenario>;   // unknown action/expectation keys rejected
export interface Scenario { name: string; params?: Partial<Params>; nodes: ScenarioNode[]; edges: ScenarioEdge[]; steps: ScenarioStep[]; }

// packages/replay/src/params.ts
export function defaultParams(): Params;                      // config/params.json via ParamSchema
export function mergeParams(base: Params, override: Partial<Params>): Params;  // shallow

// packages/replay/src/store.ts
export class MemoryStore {
  constructor(params: Params, epochMs: number);
  upsertNode(node: ScenarioNode): number;
  upsertEdge(edge: ScenarioEdge): number;
  rememberStructured(input: RememberInput, now: number): void;   // sets invalidated on superseded facts (SC-12)
  isInvalidated(id: number): boolean;
  applyUse(ids: number[], now: number, p: Params): void;         // recordAccess + reinforceEdge along last-trace pathEdges
  nodeState(id: number): NodeState; edgeState(from: number, to: number): EdgeState;
  resolveKey(key: string): number | undefined;                   // key/label/alias registry
}

// packages/replay/src/runner.ts
export interface ScenarioResult { passed: boolean; failures: ScenarioFailure[]; traces: TraceRecord[]; }
export interface ScenarioFailure { scenario: string; step: number; expectation: string; detail: string; }
export function runScenario(scenario: Scenario, opts?: { outDir?: string }): Promise<ScenarioResult>;

// packages/replay/src/trace.ts
export interface TraceRecord {          // §7 recall_trace shape
  tenant_id: string; session_id: string; client: string; at: number; query: string;
  cue_ids: number[]; cue_weights: number[];
  hops: { hop: number; from: number; to: number; edge: string; amount: number }[];  // amount >= 0.004
  recalled: { id: number; lane: string; A: number; B: number; S: number }[];
  used_ids: number[]; params: Params; duration_ms: number; expanded: number;
}
export function serializeTrace(recall: RecallOutcome, clock: InjectedClock, p: Params): TraceRecord;
export function writeTraceFile(outDir: string, scenario: string, step: number, trace: TraceRecord): Promise<void>;

// packages/replay/src/expect.ts
export function evaluateExpectations(ex: Expectations, ctx: ExpectContext): ScenarioFailure[];  // never throws
```

## 3. Verification mapping

| Task | Command |
|---|---|
| 1–2 (package + script) | `pnpm replay` (script resolves and runs the package's vitest) |
| 3 (types) | `pnpm replay` (zod parsing of all scenario YAMLs inside the test run) |
| 4 (params) | `pnpm replay` (defaults from `config/params.json`; first verify command "§4.5 defaults") |
| 5–7 (store/runner/trace) | `pnpm replay` (all 15 pass, `expanded <= maxExpanded`) and `pnpm replay && cp -r out/traces /tmp/t1 && pnpm replay && diff -r /tmp/t1 out/traces` (byte-identical) |
| 8 (expect) | `pnpm replay` (failures name scenario+step+expectation; SC-01..SC-15 all pass) |
| 9–10 (scenarios/fixture) | `pnpm replay` (exact-count assertion in replay.test.ts) |
| 11–12 (tests) | `pnpm replay`; determinism covered by the diff-rerun verification command |

## 4. Dependencies

Already present in the workspace: `@recall/activation`, `zod`, `vitest`. New package needs only `yaml` added:

```
pnpm --filter @recall/replay add yaml && pnpm --filter @recall/replay add -D vitest
```
(equivalent to editing `packages/replay/package.json` with `"yaml": "catalog:"`-style semver `^2` and `vitest` matching the activation package's version, then running `pnpm install`).
