// §7 recall_trace serialization for the replay harness (E03 task 7). Serializes
// each recall into the `recall_trace` record shape with stable key ordering, and
// writes one JSON file per scenario step. No wall clock: `at` and `duration_ms`
// come from the injected clock / pipeline shape.
import type { Params } from '@recall/activation';
import type { InjectedClock, RecallOutcome } from './runner.js';
import type { RecallAction } from './types.js';

// §10.5 step 9: keep flows with amount >= 0.004 in traces.
const PRUNE_AMOUNT = 0.004;

/** §7 recall_trace-shaped record (also re-exported by runner consumers). */
export interface TraceRecord {
  tenant_id: string;
  session_id: string;
  client: string;
  /** Simulated wall time (epoch ms) from the injected clock. */
  at: number;
  query: string;
  cue_ids: number[];
  cue_weights: number[];
  hops: { hop: number; from: number; to: number; edge: number; amount: number }[];
  recalled: { id: number; lane: string; A: number; B: number; S: number }[];
  used_ids: number[];
  params: Params;
  duration_ms: number;
  expanded: number;
}

/**
 * Serialize one recall outcome as a `recall_trace` record. Key order is fixed
 * by the literal below so JSON output is byte-stable. `action` supplies the
 * request-side fields (session/client/query); omitted only when the caller has
 * no action context (defaults match the harness' local replay session).
 */
export function serializeTrace(
  recall: RecallOutcome,
  clock: InjectedClock,
  p: Params,
  action?: Pick<RecallAction, 'session_id' | 'client' | 'query'>,
): TraceRecord {
  return {
    tenant_id: 'local',
    session_id: action?.session_id ?? 'replay',
    client: action?.client ?? 'omp',
    at: clock.nowMs(),
    query: action?.query ?? '',
    cue_ids: recall.cues.map((c) => c.id),
    cue_weights: recall.cues.map((c) => c.activation),
    hops: recall.flows
      .filter((f) => f.amount >= PRUNE_AMOUNT)
      .map((f) => ({ hop: f.hop, from: f.from, to: f.to, edge: f.edge, amount: f.amount })),
    recalled: recall.recalled.map((r) => ({ id: r.id, lane: r.lane, A: r.A, B: r.B, S: r.S })),
    used_ids: [],
    params: p,
    duration_ms: recall.durationMs,
    expanded: recall.expanded,
  };
}

/** Write one trace file: `<outDir>/<scenario>/<step>.json`, stable key order. */
export async function writeTraceFile(
  outDir: string,
  scenario: string,
  step: number,
  trace: TraceRecord,
): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = join(outDir, scenario);
  await mkdir(dir, { recursive: true });
  // JSON.stringify preserves the TraceRecord literal's key order (stable).
  await writeFile(join(dir, `${step}.json`), JSON.stringify(trace, null, 2) + '\n');
}
