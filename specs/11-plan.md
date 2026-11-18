# Implementation Plan — Card #11 (E02 Activation package, pure math)

Source spec: `specs/11-e02-activation-package.md`. Goal: implement the PRD §10.1–10.4 pure ACT-R math in `packages/activation` with 100% branch coverage and strict TS (no `any`). Nothing else is changed; tests only, no installers run here.

## 1. Task list

1. Add `src/types.ts` defining `Params`, `HalfLifeClass`, `Kind`, `NodeState`, `EdgeState`, and `Flow` with the exact shapes below. DONE: implemented per spec, committed to packages/activation/src/types.ts.
2. Fill `src/index.ts`: remove `E01_PLACEHOLDER` and export `DAY` plus every §10.1–10.4 function with the exact signatures, wiring in `config/params.json` initial values (no runtime import — inline them). DONE: implemented all functions per PRD §10; index.ts exports DAY, baseLevel, recallProbability, isDormantNode, edgeStrength, reinforceEdge, recordAccess, spread, score, pathEdges.
3. Write `test/base-level.test.ts` covering base-level (recent + hybrid tail term, dropped-term edge when `L − Δt_m < minAgeDays`, age clamping) and recall probability / dormancy branches.
4. Write `test/edges.test.ts` covering half-life decay, floor at `edgeFloor`, reinforcement decay-then-cap, `recordAccess` dormant revive, **SC-10** (dormant node used → +3 accesses, no longer dormant) and **SC-11** (edge unused 5 years → strength exactly 0.001, still traversed).
5. Write `test/spread.test.ts` covering fan division, hop limit, pruning below `pruneEpsilon`, `maxExpanded` cap, cues excluded, and frontier ordering (activation desc then id asc) for tie-breaks.
6. Write `test/scoring.test.ts` covering the `S ≥ minSpread` gate, the `A = B + spreadWeight·S ≥ recallThreshold` gate, A-desc/id-asc sort, top `resultLimit`, `pathEdges` backward walk collecting edge ids, and exposure lane. DONE: test file implemented and passing (52/52).
7. Update `test/smoke.test.ts` to import a real export (e.g. `DAY`) instead of the placeholder.
8. Add `test/determinism.property.test.ts`: seeded PRNG builds 1,000 random graphs, runs `spread` + `score` twice each, asserts byte-identical `JSON.stringify`.
9. Install `@vitest/coverage-v8` at the workspace root (`pnpm add -D -w @vitest/coverage-v8`) so `--coverage` works; keep the package dependency-free.
10. Verify: `pnpm --filter activation test --coverage` reports all green with 100% branches, run twice for NFR-07 byte-identical determinism (do not execute here).

## 2. Types and interfaces

```ts
// src/types.ts
export interface Params {
  decay: number;                 // d   0.5
  recentAccesses: number;        // M   10
  minAgeDays: number;            // Δt_min 0.01
  tau: number;                   // τ   -1.0
  noiseScale: number;            // s   0.35
  dormantP: number;              // P below this = dormant (0.2)
  edgeFloor: number;             // w_floor 0.001
  edgeInitial: number;           // w0  1.0
  edgeGain: number;              // g   0.2
  halfLifeDays: Record<HalfLifeClass, number>; // { identity: 180, default: 30, incidental: 7 }
  hops: number;                  // H   3
  damping: number;               // δ   0.7
  pruneEpsilon: number;          // ε   0.0001
  maxExpanded: number;           // N_max 2000
  seedK: number;                 // 8
  seedMinSim: number;            // 0.35
  spreadWeight: number;          // λ   10
  minSpread: number;             // θ_min 0.02
  recallThreshold: number;       // τ_A 0.5
  resultLimit: number;           // k   10
  directMinSim: number;          // σ_direct 0.80
  reviveExtraAccesses: number;   // 2
}

export type HalfLifeClass = 'identity' | 'default' | 'incidental';
export type Kind = 'entity' | 'fact' | 'episode';

export interface NodeState {
  accessCount: number;
  recentAccess: number[];       // epoch ms, newest first, at most M
  createdAt: number;            // epoch ms
}

export interface EdgeState {
  strength: number;
  lastUsedAt: number;           // epoch ms
  halfLifeClass: HalfLifeClass;
}

export type Flow = { hop: number; from: number; to: number; edge: number; amount: number };
```

```ts
// src/index.ts — exact exported signatures
export const DAY = 86_400_000;

// §10.1
export function baseLevel(n: NodeState, now: number, p: Params): number;
export function recallProbability(B: number, p: Params): number;
export function isDormantNode(B: number, p: Params): boolean;

// §10.2
export function edgeStrength(e: EdgeState, now: number, p: Params): number;
export function reinforceEdge(e: EdgeState, now: number, p: Params): EdgeState; // returns new state (decay folded in, gain capped at 1, lastUsedAt = now)
export function recordAccess(n: NodeState, now: number, p: Params, wasDormant: boolean): NodeState;

// §10.3
export function spread(g: Graph, cues: Cue[], now: number, p: Params): Flow[];

// §10.4
export function score(nodes: Nodes, activation: Activation, now: number, p: Params): ScoreRow[];
export function pathEdges(flows: Flow[], target: number): number[]; // returns edge ids
```

Where the traversal inputs are:

```ts
export interface Graph {
  nodes: Map<number, NodeState>;
  edges: Array<{ id: number; from: number; to: number; state: EdgeState; superseded?: boolean }>;
}
export type Cue = { id: number; activation: number }; // source activation (1.0 explicit, cosine similarity via vector search)
```

> Note: `Graph`, `Cue`, `Nodes`, `Activation`, and `ScoreRow` are helper input/output shapes that the exact signature in the spec leaves open (`spread(g, cues, now, p)` and `score(nodes, activation, now, p)`). They are listed here as the minimal concrete types; refine to whatever minimal shape keeps strict TS with no `any`.

> Build note: tsc found `spread` already reading `g.adj` while `Graph` declared a flat `edges` list; `Graph` now carries `adj: Map<number, Array<{ id, to } & EdgeState>>` (the `edges`/`GraphEdge` shape was unused and is gone), `index.ts` re-exports the type surface from the package root, the two `noUncheckedIndexedAccess` errors on `tm` in `baseLevel` are fixed with an `undefined` guard, and the package build is type-check only (`noEmit`) so tsc does not drop compiled `.js`/`.d.ts` next to sources where vitest would pick them up.

## 3. Verification mapping

| Task | Verification command that exercises it |
| --- | --- |
| Task 1–2 (all math + exports) | `pnpm --filter activation test --coverage` — every test must pass; coverage table shows 100% branches per file (NFR-17). |
| Tasks 3, 4 (`baseLevel`, recall, edges, SC-10/SC-11) | Same command; `test/base-level.test.ts` and `test/edges.test.ts` cover the dormant-recall branch. |
| Task 5 (`spread`) | `pnpm --filter activation test --coverage`; determinism property runs `spread` twice per graph (NFR-07). |
| Task 6 (`score`, `pathEdges`) | Same command; `test/scoring.test.ts`. Determinism property exercises `score` twice per graph. |
| Task 7 (smoke) | `pnpm --filter activation test`; smoke must import a real export and pass. |
| Task 8 (determinism) | `pnpm --filter activation test`; `test/determinism.property.test.ts` asserts byte-identical JSON across its two internal runs, run twice consecutively (NFR-07). |
| Task 9 (coverage tooling) | Required for the `--coverage` flag to emit the NFR-17 branch table. |

Verification step from spec: *"Run that command twice consecutively — both runs green, with the determinism property test asserting byte-identical JSON across its two internal runs in each execution."*

## 4. Dependencies

One devDependency at the workspace root (package itself stays dependency-free):

```
pnpm add -D -w @vitest/coverage-v8
```

No runtime dependencies are added to `@recall/activation`. `typescript`, `vitest`, and existing tooling cover the rest; `DAY` is a plain literal constant with no import needed.
