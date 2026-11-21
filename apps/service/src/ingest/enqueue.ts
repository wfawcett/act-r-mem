// §11 ingest queue enqueue: `remember` and the transcript route only insert one
// `ingest_queue` row (FR-01/02) — no LLM, embed, or activation call anywhere in
// this module. Validation via zod (RememberInput §8.1, TranscriptRequest §9.2).
import { z } from 'zod';
import { pool } from '../db/pool.js';

const ClientValue = z.enum(['claude-code', 'hermes', 'omp', 'manual']);
const TranscriptClient = z.enum(['claude-code', 'hermes', 'omp']);
const HalfLifeClass = z.enum(['identity', 'default', 'incidental']);

// --- RememberStructured (§8.1) -----------------------------------------------
export const RememberStructuredSchema = z.object({
  entities: z
    .array(z.object({ label: z.string().min(1), aliases: z.array(z.string().min(1)).optional() }))
    .default([]),
  facts: z
    .array(z.object({ subject: z.string().min(1), statement: z.string().min(1), half_life_class: HalfLifeClass.optional() }))
    .default([]),
  episode: z.object({ label: z.string().min(1), summary: z.string().min(1) }).optional(),
  edges: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        predicate: z.string().min(1),
        half_life_class: HalfLifeClass.optional(),
      }),
    )
    .default([]),
});

// --- RememberInput (§8.1) ----------------------------------------------------
export const RememberInputSchema = z.object({
  text: z.string().min(1).max(20000),
  occurred_at: z.string().optional(),
  session_id: z.string().min(1).optional(),
  client: ClientValue.optional(),
  structured: RememberStructuredSchema.optional(),
});

// --- TranscriptRequest (§9.2) ------------------------------------------------
export const TranscriptTurnSchema = z.object({
  index: z.number().int().nonnegative(),
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
  at: z.string().min(1),
});

export const TranscriptRequestSchema = z.object({
  client: TranscriptClient,
  session_id: z.string().min(1),
  turns: z.array(TranscriptTurnSchema).min(1).max(200),
});

export type RememberStructured = z.infer<typeof RememberStructuredSchema>;
export type RememberInput = z.infer<typeof RememberInputSchema>;
export type TranscriptRequest = z.infer<typeof TranscriptRequestSchema>;

// The service currently runs single-tenant locally (§6.1): every row lands in
// the 'local' tenant.
const TENANT_ID = 'local';

export interface QueuedItem {
  queued_id: number;
}

async function insertQueue(
  kind: 'remember' | 'transcript',
  client: string,
  sessionId: string | null,
  payload: unknown,
): Promise<QueuedItem> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO ingest_queue (tenant_id, kind, client, session_id, payload, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING id`,
    [TENANT_ID, kind, client, sessionId, JSON.stringify(payload)],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('INSERT INTO ingest_queue returned no row');
  const queuedId = Number(row.id);
  if (!Number.isSafeInteger(queuedId)) throw new Error(`ingest_queue id is not a safe integer: ${row.id}`);
  return { queued_id: queuedId };
}

/**
 * FR-01: validate a `remember` input and enqueue it as one pending row.
 * The payload stores `{ text, occurred_at, structured? }` (§8.1 / FR-05:
 * structured input is stored as-is, processed later without extract()).
 */
export async function enqueueRemember(input: RememberInput): Promise<QueuedItem> {
  const parsed = RememberInputSchema.parse(input);
  const payload: Record<string, unknown> = { text: parsed.text };
  if (parsed.occurred_at !== undefined) payload.occurred_at = parsed.occurred_at;
  if (parsed.structured !== undefined) payload.structured = parsed.structured;
  return insertQueue('remember', parsed.client ?? 'manual', parsed.session_id ?? null, payload);
}

/**
 * FR-02: validate a transcript request and enqueue it as one pending row.
 * The payload stores `{ turns }`.
 */
export async function enqueueTranscript(req: TranscriptRequest): Promise<QueuedItem> {
  const parsed = TranscriptRequestSchema.parse(req);
  return insertQueue('transcript', parsed.client, parsed.session_id, { turns: parsed.turns });
}
