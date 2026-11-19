# Spec: E02 Activation package (pure math) — card #11

## Goal
`packages/activation` exports the complete pure ACT-R math of PRD §10.1–10.4, so that given node/edge state and a `now` parameter it deterministically computes base level, recall probability, dormancy, edge strength/reinforcement, spreading activation, lane scoring, and reinforcement path edges — with 100% branch coverage (NFR-17), strict TS and no `any` (NFR-16), and byte-identical output across runs (NFR-07).

## Approach
Replace the E01 placeholder in `packages/activation`:

- `src/types.ts` — new: `Params` (one config type mirroring §4.5 names; initial values match `config/params.json`), `HalfLifeClass = 'identity' | 'default' | 'incidental'`, `Kind = 'entity' | 'fact' | 'episode'`, `NodeState { accessCount: number; recentAccess: number[]; createdAt: number }` (recentAccess newest first, epoch ms), `EdgeState { strength: number; lastUsedAt: number; halfLifeClass: HalfLifeClass }`, `Flow { hop: number; from: number; to: number; edge: number; amount: number }`.
- `src/index.ts` — remove `E01_PLACEHOLDER`; export the PRD §10.1–10.4 functions with their exact signatures, plus `DAY = 86_400_000`:
  - §10.1: `baseLevel(n, now, p)` (Petrov hybrid tail term; dropped when `L − Δt_m < minAgeDays`; ages clamped to `minAgeDays`), `recallProbability(B, p)`, `isDormantNode(B, p)`.
  - §10.2: `edgeStrength(e, now, p)` (half-life decay floored at `p.edgeFloor`), `reinforceEdge(e, now, p)` (decay folded in first, gain capped at 1, `lastUsedAt = now`), `recordAccess(n, now, p, wasDormant)` (adds `1 + reviveExtraAccesses` stamps when dormant).
  - §10.3: `spread(g, cues, now, p)` — fan division per source node, up to `hops` hops, flows below `pruneEpsilon` pruned, at most `maxExpanded` nodes expanded, cues never receive activation; frontier ordered by activation desc then id asc (ties break ascending).
  - §10.4: `score(nodes, activation, now, p)` — gates `S ≥ minSpread` and `A = B + spreadWeight·S ≥ recallThreshold`; sorted A desc with ties by ascending id; top `resultLimit`. `pathEdges(flows, target)` — walk flows backwards from the target to the cues, collecting edge ids.
- Tests in `test/`: `base-level.test.ts`, `edges.test.ts`, `spread.test.ts`, `scoring.test.ts` covering every branch, including SC-10 (a dormant node that is used gains 3 accesses and is no longer dormant) and SC-11 (an edge unused for 5 years has strength exactly 0.001 and is still traversed); update `test/smoke.test.ts` to import a real export instead of the placeholder; add `test/determinism.property.test.ts`: a seeded PRNG builds 1,000 random graphs, runs `spread` + `score` twice per graph, asserts byte-identical `JSON.stringify` output (NFR-07).
- Root `package.json` — add `@vitest/coverage-v8` to workspace-root devDependencies (`pnpm add -D -w @vitest/coverage-v8`) so `--coverage` works; the package itself gets zero runtime deps.

## Verification
1. `pnpm --filter activation test --coverage` — vitest reports all tests passing and the coverage table shows 100% branches for every file (NFR-17).
2. Run that command twice consecutively: both runs green, with the determinism property test asserting byte-identical JSON across its two internal runs in each execution (NFR-07).

## Out of scope
Node/Postgres/network imports; `Date.now()` or randomness inside the package (`now` is always a parameter); service code (§10.5 pipeline, §10.6 flush), replay harness runner (E03), UI, embeddings/vector search, and the Phase 3 SQL surface (§10.7).
