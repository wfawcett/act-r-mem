// Replay suite runner (E03 task 11). Globs every `scenarios/*.yaml`, asserts
// SC-01..SC-15 are present exactly once, runs each scenario through the
// in-memory runner (with the SC-15 setup fixture hook), writes one
// `out/traces/<scenario>/<step>.json` trace file per recall step, and asserts
// every scenario passes and every recall respects the maxExpanded node cap.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'yaml';
import { runScenario } from '../src/runner.js';
import { ScenarioSchema } from '../src/types.js';
import { getSetupFixture } from './fixtures/sc-15-seed.js';
import { writeTraceFile } from '../src/trace.js';

const ROOT = new URL('../../..', import.meta.url).pathname;
const SCENARIOS_DIR = `${ROOT}/scenarios`;
const TRACE_OUT_DIR = `${ROOT}/out/traces`;

const EXPECTED = Array.from({ length: 15 }, (_, i) => `sc-${String(i + 1).padStart(2, '0')}`);

function loadScenarios(): { file: string; id: string; name: string; scenario: ReturnType<typeof ScenarioSchema.parse> }[] {
  const files = readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .sort();
  return files.map((file) => {
    const id = file.replace(/\.yaml$/, '');
    const scenario = ScenarioSchema.parse(parse(readFileSync(`${SCENARIOS_DIR}/${file}`, 'utf8')));
    return { file, id, name: scenario.name, scenario };
  });
}

describe('replay scenario suite', () => {
  it('has SC-01..SC-15 present exactly once', () => {
    const scenarios = loadScenarios();
    for (const id of EXPECTED) {
      const matches = scenarios.filter((s) => s.id === id);
      expect(matches, `expected exactly one ${id}.yaml, got ${matches.map((m) => m.file).join(', ') || 'none'}`).toHaveLength(1);
    }
    // No duplicates and no unexpected ids either.
    expect(scenarios.map((s) => s.id)).toEqual(EXPECTED);
  });

  for (const id of EXPECTED) {
    it(`${id} passes with traces written and expanded <= maxExpanded`, async () => {
      const scenarios = loadScenarios();
      const entry = scenarios.find((s) => s.id === id);
      expect(entry, `${id}.yaml missing`).toBeDefined();

      const result = runScenario(entry!.scenario, {
        setup: getSetupFixture,
      });

      // One trace file per recall step, numbered by its actual step position.
      let traceIdx = 0;
      for (const [i, step] of entry!.scenario.steps.entries()) {
        if (!step.recall) continue;
        const trace = result.traces[traceIdx];
        expect(trace, `step ${i + 1} recall produced no trace`).toBeDefined();
        traceIdx++;
        expect(trace!.expanded, `step ${i + 1} expanded beyond maxExpanded`).toBeLessThanOrEqual(trace!.params.maxExpanded);
        await writeTraceFile(TRACE_OUT_DIR, entry!.scenario.name, i + 1, trace!);
      }
      // Scenarios may legitimately be state-only (e.g. SC-05/06/13 assert B
      // bounds and dormancy without a recall step), so zero traces is fine.

      if (!result.passed) {
        throw new Error(
          `${id} failed:\n${result.failures
            .map((f) => `  [${f.expectation}] step ${f.step}: ${f.detail}`)
            .join('\n')}`,
        );
      }
    }, 60_000);
  }
});
