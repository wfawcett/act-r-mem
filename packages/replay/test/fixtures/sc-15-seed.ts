// SC-15 setup fixture (E03 task 10, PRD §15.3 SC-15). The only registered
// `setup` fixture hook: generates the 50,000-node graph programmatically so the
// scale scenario stays a few lines of YAML. Shape: one `hub` node (the same
// node SC-15 declares in its own node list — `upsertNode` is idempotent, so the
// fixture's copy wins if it is loaded first) fanned out to 49,999 leaf
// entities via strength-1 edges created at day 0. Leaves are never accessed,
// so they start maximally stale and the recall must complete under the
// `maxExpanded` node cap while the hub itself stays active.
import type { ScenarioEdge, ScenarioNode } from '../../src/types.js';
import type { SetupFixture } from '../../src/runner.js';

export const SC15_TOTAL_NODES = 50_000;
export const SC15_LEAF_COUNT = SC15_TOTAL_NODES - 1;

export function sc15SeedFixture(): SetupFixture {
  const nodes: ScenarioNode[] = [
    {
      key: 'hub',
      kind: 'entity',
      label: 'Hub',
      aliases: [],
      accesses: [0],
      created: 0,
    },
  ];
  const edges: ScenarioEdge[] = [];
  for (let i = 1; i <= SC15_LEAF_COUNT; i++) {
    const key = `leaf-${String(i).padStart(5, '0')}`;
    nodes.push({ key, kind: 'entity', label: `Leaf ${i}`, aliases: [], accesses: [], created: 0 });
    edges.push({ from: 'hub', to: key, predicate: 'relates', strength: 1, lastUsed: 0 });
  }
  return { nodes, edges };
}

// Registry the runner's `opts.setup` hook resolves against. Returns undefined
// for unknown names — runScenario turns that into a named "setup" failure.
export function getSetupFixture(name: string): SetupFixture | undefined {
  if (name === 'sc-15-seed') return sc15SeedFixture();
  return undefined;
}
