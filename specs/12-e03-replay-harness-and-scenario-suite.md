# Spec: E03 Replay harness and scenario suite (card #12)

## Goal
`pnpm replay` runs 15 YAML scenarios (PRD §15.3 SC-01..SC-15) through an in-memory replay harness (§15.2) — injected clock, stub embedder with declared similarities, no database — and all pass with the §4.5 defaults, writing one `recall_trace`-shaped JSON file per recall under `out/traces/` that is byte-identical across consecutive runs.

## Approach
- `packages/replay/package.json` — name `@recall/replay`, `"type":"module"`, devDeps: `vitest`; deps: `yaml`, `zod`, `@recall/activation` (`workspace:*`); script `test`: `vitest run`. `pnpm-workspace.yaml` already covers `packages/*`; add only a root script `"replay": "pnpm --filter @recall/replay test"`.
- `packages/replay/src/types.ts` — zod schema + inferred types for the §15.2 YAML: `Scenario { name, params?: Partial<Params>, nodes: [{key, kind, label, accesses: number[], created}], edges: [{from, to, predicate, strength, lastUsed}], steps: [{at, recall?: {cues?|query?, similar?: Record<key, sim>}, use?: keys[], remember?: structured, advance?: days, expect?: Expectations}] }`; `Expectations` covers `associative_includes`, `associative_excludes`, `associative_top` (ordered), `exposure_includes`, `direct_is`, `none_of`, `node: {key, dormant?|active?, B_gt?, B_lt?}`, `edge: {from, to, strength_gt?, strength_lt?}`. Unknown action/expectation keys rejected.
- `packages/replay/src/params.ts` — `defaultParams(): Params` reads `config/params.json` and validates it with `ParamSchema` imported from `apps/service/src/config.ts` (config.ts has no pg/env coupling) so the PRD §4.5 file stays the single source of defaults; scenario `params` are shallow-merged over it.
- `packages/replay/src/store.ts` — `MemoryStore`: in-memory graph (Map-based nodes/edges mirroring `packages/activation` `Graph`/`Nodes`), key→id registry, label/alias resolution; `invalidated` flag on nodes/edges (superseded facts excluded from all lanes — SC-12); `applyUse(ids, now, p)` applies `recordAccess` and `reinforceEdge` along `pathEdges` of the last trace's flows inline (§10.6 flush semantics, no buffer/timer).
- `packages/replay/src/runner.ts` — `runScenario(scenario): { passed, failures, traces }`:
  - Injected clock: `now = epoch + at * DAY`; `advance` moves the clock only.
  - Stub embedder: `query` + `similar: {key: sim}` yields `Cue { id, activation: sim }`; explicit cues get activation 1.0; seeds = top `seedK` declared sims with `sim >= seedMinSim` merged with explicit cues (§10.5 step 3 without vectors).
  - Recall pipeline §10.5 steps 4–8 in memory: neighborhood load honoring the `maxExpanded` expanded-node cap (count nodes expanded, not flows — PRD §10.3 pseudocode), `spread`, `score`, exposure lane (episode neighbors, dormant included, `via` = episode id), direct lane (declared similarity over fact nodes, gate `directMinSim`, none if already present). No randomness, no `Date.now()`.
  - `remember` (structured only) upserts nodes/edges/facts per `RememberInput.structured`; a new fact contradicts a same-subject existing fact only when the scenario's `structured` names it (no LLM judge — SC-12 declares both).
- `packages/replay/src/trace.ts` — serialize each recall as `{ tenant_id: 'local', session_id, client, at, query, cue_ids, cue_weights, hops: [{hop, from, to, edge, amount}], recalled: [{id, lane, A, B, S}], used_ids, params, duration_ms, expanded }` matching §7 `recall_trace`; flows pruned to `amount >= 0.004`; `duration_ms` derived from the injected clock, stable key ordering, no wall clock.
- `packages/replay/src/expect.ts` — evaluate expectations against lane results and node/edge state (dormancy via `recallProbability`/`dormantP`); collect failures with scenario/step/expectation names, never throw.
- `scenarios/sc-01.yaml`..`sc-15.yaml` — one per §15.3 row; SC-01 uses the exact §15.2 example graph; SC-02's 40-episode fan enumerated in YAML; SC-13 asserts the tail approximation via `node: {B_gt, B_lt}` bounds; SC-15 uses an optional `setup` fixture (`packages/replay/test/fixtures/sc-15-seed.ts`) generating 50k nodes programmatically — the only fixture hook.
- `packages/replay/test/replay.test.ts` — reads every `scenarios/*.yaml`, asserts SC-01..SC-15 present exactly once, runs each, writes `out/traces/<scenario>/<step>.json`, asserts pass and `expanded <= maxExpanded`; `determinism.test.ts` runs the suite twice into two temp dirs and asserts byte-identical files.

## Verification
```
pnpm replay          # all 15 scenarios pass; failures name scenario+step+expectation
pnpm replay && cp -r out/traces /tmp/t1 && pnpm replay && diff -r /tmp/t1 out/traces
```
First command proves SC-01..SC-15 pass with §4.5 defaults; second proves SC-14 byte-identical trace files (empty diff). CI runs the suite twice and diffs the traces.

## Out of scope
Database, Postgres/pgvector, service routes, MCP tools, ingest pipeline and worker; real LiteLLM embedder; UI; `pnpm bench`; P3 conformance backend; parameter tuning — if a default must change to pass, the change lands in `config/params.json` with before/after scenario results in the PR, not in the harness.
