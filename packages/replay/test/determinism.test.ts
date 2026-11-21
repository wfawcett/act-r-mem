// E03 task 12 — determinism: run the whole SC-01..SC-15 suite twice into two
// temp dirs and assert every trace file is byte-identical across runs. No
// randomness, no wall clock anywhere in the harness, so consecutive runs must
// produce the same bytes.
import { describe, expect, it } from 'vitest';
import { readdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ScenarioSchema } from '../src/types.js';
import { runScenario } from '../src/runner.js';
import { writeTraceFile } from '../src/trace.js';
import { getSetupFixture } from './fixtures/sc-15-seed.js';

const SCENARIOS_DIR = new URL('../../../scenarios/', import.meta.url).pathname;

async function runSuiteInto(dir: string): Promise<string[]> {
  const files = (await readdir(SCENARIOS_DIR)).filter((f) => f.endsWith('.yaml')).sort();
  const written: string[] = [];
  for (const file of files) {
    const scenario = ScenarioSchema.parse(parse(await readFile(join(SCENARIOS_DIR, file), 'utf8')));
    const result = runScenario(scenario, { setup: getSetupFixture });
    expect(result.failures, `${scenario.name} failures: ${JSON.stringify(result.failures)}`).toEqual([]);
    expect(result.passed).toBe(true);
    for (const [i, trace] of result.traces.entries()) {
      await writeTraceFile(dir, scenario.name, i + 1, trace);
      written.push(`${scenario.name}/${i + 1}.json`);
    }
  }
  return written.sort();
}

describe('replay determinism', () => {
  it('produces byte-identical traces across two consecutive suite runs', async () => {
    const runA = await mkdtemp(join(tmpdir(), 'replay-determinism-a-'));
    const runB = await mkdtemp(join(tmpdir(), 'replay-determinism-b-'));
    try {
      const filesA = await runSuiteInto(runA);
      expect(filesA.length, 'expected at least one trace file').toBeGreaterThan(0);
      const filesB = await runSuiteInto(runB);
      expect(filesB).toEqual(filesA);

      for (const rel of filesA) {
        const a = await readFile(join(runA, rel), 'utf8');
        const b = await readFile(join(runB, rel), 'utf8');
        expect(b, `${rel} differs between runs`).toBe(a);
      }
    } finally {
      await rm(runA, { recursive: true, force: true });
      await rm(runB, { recursive: true, force: true });
    }
  }, 120_000);
});
