// One recall_trace row per recall (FR-15). Any failure is logged and swallowed,
// never thrown.
import type { RecallDeps } from './deps.js';

export interface TraceData {
  tenant: string;
  sessionId: string | undefined;
  client: string;
  query: string;
  cueIds: number[];
  cueWeights: number[];
  hops: { hop: number; from: number; to: number; edge: number; amount: number }[]; // amount >= 0.004
  recalled: { id: number; lane: string; A: number | null; B: number | null; S: number | null }[];
  params: Record<string, unknown>;
  durationMs: number;
}

export async function writeTrace(deps: RecallDeps, data: TraceData): Promise<number | undefined> {
  try {
    const result = await deps.db.query<{ id: number }>(
      `INSERT INTO recall_trace
         (tenant_id, session_id, client, query, cue_ids, cue_weights, hops, recalled, params, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        data.tenant,
        data.sessionId ?? null,
        data.client,
        data.query,
        data.cueIds,
        data.cueWeights,
        JSON.stringify(data.hops),
        JSON.stringify(data.recalled),
        JSON.stringify(data.params),
        data.durationMs,
      ],
    );
    return result.rows[0]?.id;
  } catch (err) {
    console.error(`[recall] writeTrace failed (swallowed): ${(err as Error).message}`);
    return undefined;
  }
}
