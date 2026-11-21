// E09 MCP tool handlers (§8). Thin per-tool functions so unit tests can call
// them without a transport. Validation failures throw `ToolValidationError`
// with the exact §8.6 short messages; the dispatch layer (server.ts) turns them
// into MCP error results verbatim. Unexpected errors are logged with the
// request id by `logError` and surfaced as "Memory is unavailable right now".
import { z } from 'zod';
import { isDormantNode } from '@recall/activation';
import type { Pool } from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { RememberInputSchema, enqueueRemember, type RememberInput } from '../ingest/enqueue.js';
import { recall } from '../recall/pipeline.js';
import type { RecallResult, RecalledMemory } from '../recall/deps.js';
import type { UseBuffer } from '../reinforce/buffer.js';
import { forgetNode } from '../reinforce/forget.js';

// --- deps ---------------------------------------------------------------------
export interface McpToolDeps {
  pool: Pool; // shared pool; recallTool opens a per-call PoolClient transaction
  config: Config; // params snapshot (resultLimit default), contextMaxChars, tenant 'local'
  embed(text: string): Promise<number[]>; // LiteLLM embed, created in register.ts from config
  useBuffer: Pick<UseBuffer, 'add'>; // app.useBuffer (FR-19/FR-22 producers)
  log: FastifyBaseLogger; // request-scoped logger; Fastify attaches the request id
}

export class ToolValidationError extends Error {} // message returned to the model verbatim (§8.6)

/** Log an internal error with the request id; caller then returns the §8.6 generic message. */
export function logError(requestId: string, err: unknown): void {
  deps_logError(requestId, err);
}

// Module-level indirection keeps the signature dependency-free while still using
// the request-scoped logger when one is bound (set via bindLogError in register.ts).
let deps_logError: (requestId: string, err: unknown) => void = (requestId, err) => {
  console.error(`[mcp] request ${requestId} internal error:`, err);
};

/** Bind the internal-error logger to a Fastify logger so messages carry the request id. */
export function bindLogError(log: FastifyBaseLogger): void {
  deps_logError = (requestId, err) => {
    log.error({ requestId, err }, `[mcp] request ${requestId} internal error`);
  };
}

// --- input schemas (§8) ---------------------------------------------------------
export const RecallToolSchema = z.object({
  query: z.string().min(1).max(4000),
  cues: z.array(z.string().min(1)).optional(),
  limit: z.number().int().min(1).max(25).optional(),
  session_id: z.string().min(1).optional(),
  client: z.string().min(1).optional(),
});

export const MarkUsedToolSchema = z.object({
  trace_id: z.number().int().positive().optional(),
  ids: z.array(z.number().int().positive()).min(1).max(50),
});

export const GetMemoryToolSchema = z.object({
  id: z.number().int().positive(),
});

export const ForgetToolSchema = z.object({
  id: z.number().int().positive(),
  reason: z.string().optional(),
});

export interface RecallToolInput {
  query: string;
  cues?: string[];
  limit?: number;
  session_id?: string;
  client?: string;
}

export interface MemoryConnection {
  id: number;
  label: string;
  kind: 'entity' | 'fact' | 'episode';
  predicate: string;
  strength: number;
  dormant: boolean;
}

const TENANT_ID = 'local';

// §8.6: short, model-actionable validation messages.
function firstIssue(err: z.ZodError): string {
  const issue = err.issues[0];
  const path = issue?.path?.length ? `${issue.path.map(String).join('.')}: ` : '';
  return `${path}${issue?.message ?? 'invalid input'}`;
}

// --- remember (§8.1) --------------------------------------------------------------
export async function rememberTool(deps: McpToolDeps, input: RememberInput): Promise<{ queued_id: number }> {
  const parsed = RememberInputSchema.safeParse(input);
  if (!parsed.success) {
    if (parsed.error.issues.some((i) => i.path[0] === 'text' && i.message === 'Too small: expected string to have >=1 characters')) {
      throw new ToolValidationError('text is empty');
    }
    throw new ToolValidationError(firstIssue(parsed.error));
  }
  return enqueueRemember(parsed.data);
}

// --- recall (§8.2) -----------------------------------------------------------------
export async function recallTool(deps: McpToolDeps, input: RecallToolInput): Promise<RecallResult> {
  const parsed = RecallToolSchema.safeParse(input);
  if (!parsed.success) {
    if (parsed.error.issues.some((i) => i.path[0] === 'query' && i.message === 'Too small: expected string to have >=1 characters')) {
      throw new ToolValidationError('query is empty');
    }
    throw new ToolValidationError(firstIssue(parsed.error));
  }

  // RecallDeps.db must be a transaction-capable PoolClient: open one per call.
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await recall(
      {
        tenant: TENANT_ID,
        sessionId: parsed.data.session_id ?? 'mcp-default',
        query: parsed.data.query,
        explicitCues: (parsed.data.cues ?? []).map((cue) => {
          const id = Number(cue);
          return Number.isSafeInteger(id) && String(id) === cue.trim() ? { id } : { label: cue };
        }),
        ...(parsed.data.client !== undefined && { client: parsed.data.client }),
        ...(parsed.data.limit !== undefined && { limit: parsed.data.limit }),
      },
      {
        embed: deps.embed,
        db: client,
        params: deps.config.params,
        contextMaxChars: deps.config.contextMaxChars,
      },
    );
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      deps.log.error({ err: rollbackErr }, '[mcp] recall ROLLBACK failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

// --- mark_used (§8.3) -----------------------------------------------------------------
export async function markUsedTool(
  deps: McpToolDeps,
  input: { trace_id?: number; ids: number[] },
): Promise<{ accepted: number }> {
  const parsed = MarkUsedToolSchema.safeParse(input);
  if (!parsed.success) {
    throw new ToolValidationError('ids must contain 1..50 ids');
  }
  // flushUses (E08) already handles trace-path edge reinforcement and used_ids
  // appends when a use carries traceId, so mark_used only feeds the buffer.
  for (const nodeId of parsed.data.ids) {
    deps.useBuffer.add({ nodeId, ...(parsed.data.trace_id !== undefined && { traceId: parsed.data.trace_id }) });
  }
  return { accepted: parsed.data.ids.length };
}

// --- get_memory (§8.4) -------------------------------------------------------------------
export async function getMemoryTool(
  deps: McpToolDeps,
  input: { id: number },
): Promise<RecalledMemory & { connections: MemoryConnection[] }> {
  const parsed = GetMemoryToolSchema.safeParse(input);
  if (!parsed.success) throw new ToolValidationError(firstIssue(parsed.error));

  const nodeRes = await deps.pool.query(
    `SELECT id, kind, label, content, occurred_at, access_count, recent_access, created_at
     FROM nodes WHERE tenant_id = $1 AND id = $2 AND invalid_at IS NULL`,
    [TENANT_ID, parsed.data.id],
  );
  const row = nodeRes.rows[0] as
    | {
        id: string;
        kind: 'entity' | 'fact' | 'episode';
        label: string;
        content: string | null;
        occurred_at: Date | string | null;
        access_count: number;
        recent_access: Date[] | string[];
        created_at: Date | string;
      }
    | undefined;
  if (row === undefined) throw new ToolValidationError(`No memory with id ${parsed.data.id}`);

  const edgesRes = await deps.pool.query(
    `SELECT e.id, e.predicate, e.strength,
            CASE WHEN e.src = $2 THEN e.dst ELSE e.src END AS other,
            n.label, n.kind
     FROM edges e
     JOIN nodes n ON n.id = CASE WHEN e.src = $2 THEN e.dst ELSE e.src END
     WHERE e.tenant_id = $1 AND (e.src = $2 OR e.dst = $2) AND e.invalid_at IS NULL AND n.invalid_at IS NULL
     ORDER BY e.strength DESC, e.id`,
    [TENANT_ID, parsed.data.id],
  );

  const params = deps.config.params;
  const now = Date.now();
  const DAY = 86_400_000;
  const recentAccess = (row.recent_access as (Date | string)[]).map((t) => new Date(t as string).getTime());
  const ages = recentAccess.map((t) => Math.max((now - t) / DAY, params.minAgeDays));
  let sum = 0;
  for (const a of ages) sum += Math.pow(a, -params.decay);
  const baseLevel = sum; // accessCount rows beyond recentAccess are already counted in the window

  const memory: RecalledMemory = {
    id: Number(row.id),
    kind: row.kind,
    label: row.label,
    content: row.content,
    lane: 'direct',
    activation: null,
    base_level: baseLevel,
    spread: null,
    occurred_at: row.occurred_at ? new Date(row.occurred_at as string).toISOString() : null,
    via: null,
  };

  const connections: MemoryConnection[] = (edgesRes.rows as {
    id: string;
    predicate: string;
    strength: number;
    other: string;
    label: string;
    kind: 'entity' | 'fact' | 'episode';
  }[]).map((e) => ({
    id: Number(e.id),
    label: e.label,
    kind: e.kind,
    predicate: e.predicate,
    strength: Number(e.strength),
    dormant: isDormantNode(baseLevel, params) || Number(e.strength) <= params.edgeFloor,
  }));

  // FR-22: a direct get counts as a use of the node.
  deps.useBuffer.add({ nodeId: memory.id });
  return { ...memory, connections };
}

// --- forget (§8.5) ---------------------------------------------------------------------------
export async function forgetTool(
  deps: McpToolDeps,
  input: { id: number; reason?: string },
): Promise<{ forgotten: true }> {
  const parsed = ForgetToolSchema.safeParse(input);
  if (!parsed.success) throw new ToolValidationError(firstIssue(parsed.error));

  const exists = await deps.pool.query(
    `SELECT 1 FROM nodes WHERE tenant_id = $1 AND id = $2 AND invalid_at IS NULL`,
    [TENANT_ID, parsed.data.id],
  );
  if (exists.rows.length === 0) throw new ToolValidationError(`No memory with id ${parsed.data.id}`);
  await forgetNode(deps.pool, parsed.data.id);
  return { forgotten: true };
}
