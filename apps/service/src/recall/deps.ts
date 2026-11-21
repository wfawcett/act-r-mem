// Injectable dependencies and input/result shapes for the recall pipeline
// (card #15, plan §2 — tests stub `embed` and pass a live test-db client).
import type { PoolClient } from 'pg';
import type { Params } from '../config.js';

export interface RecallDeps {
  embed(text: string): Promise<number[]>;
  db: PoolClient; // transaction-capable executor; tests inject a live client
  params: Params; // config snapshot used for spread/score and the trace row
}

export interface RecallInput {
  tenant: string; // defaults handled by callers; 'local' in tests
  sessionId: string;
  query: string; // 1..4000 chars (§8.2)
  explicitCues: { id?: number; label?: string }[]; // node ids as numbers or label strings
  client?: string; // default 'local'
  now?: number; // epoch ms; defaults Date.now() at the call boundary only
  limit?: number; // 1..25, default params.resultLimit
}

// pipeline.ts — §8.2 shapes
export type Lane = 'associative' | 'exposure' | 'direct';

export interface RecalledMemory {
  id: number;
  kind: 'entity' | 'fact' | 'episode';
  label: string;
  content: string | null;
  lane: Lane;
  activation: number | null; // A; null for exposure and direct
  base_level: number; // B
  spread: number | null; // S; null for exposure and direct
  occurred_at: string | null; // ISO string or null
  via: number | null; // for exposure: the episode id that exposed it
}

export interface RecallResult {
  trace_id: number | undefined; // set after writeTrace; writeTrace never throws
  memories: RecalledMemory[]; // associative ranked by A desc, then exposure, then direct
  text: string; // ≤ CONTEXT_MAX_CHARS, one memory per line, ids included (FR-18)
}
