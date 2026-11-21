import type { Pool, PoolClient } from 'pg';
import {
  baseLevel,
  isDormantNode,
  pathEdges,
  recordAccess,
  reinforceEdge,
  type Flow,
  type HalfLifeClass,
  type NodeState,
} from '@recall/activation';
import type { Params } from '../config.js';
import type { UseInput } from './buffer.js';

export interface FlushCounts {
  nodes: number;
  edges: number;
  traces: number;
}

// Date objects coming back from node-pg over timestamptz.
function toMs(d: Date): number {
  return d.getTime();
}

function fromMs(t: number): Date {
  return new Date(t);
}

interface NodeRow {
  id: number;
  access_count: number;
  recent_access: Date[] | null;
  created_at: Date;
}

interface EdgeRow {
  id: number;
  strength: number;
  last_used_at: Date;
  half_life_class: string;
}

function asNodeState(row: NodeRow): NodeState {
  return {
    accessCount: row.access_count,
    // Stored newest first; keep that order for baseLevel.
    recentAccess: (row.recent_access ?? []).map(toMs),
    createdAt: toMs(row.created_at),
  };
}

// Applies a batch of buffered "uses" in ONE transaction (FR-19/NFR-06): node bumps with the
// dormant-revival bonus (FR-20), edge reinforcement along trace paths (FR-21), and used_ids
// appends — all against a single client pulled from the pool.
export async function flushUses(
  pool: Pool,
  params: Params,
  uses: readonly UseInput[],
  now: number,
): Promise<FlushCounts> {
  if (uses.length === 0) return { nodes: 0, edges: 0, traces: 0 };

  // Node ids and trace→used-node-ids, deduped within the batch.
  const nodeIds = [...new Set(uses.map((u) => u.nodeId))];
  const usedPerTrace = new Map<number, number[]>();
  for (const u of uses) {
    if (u.traceId === undefined) continue;
    const list = usedPerTrace.get(u.traceId) ?? [];
    if (!list.includes(u.nodeId)) list.push(u.nodeId);
    usedPerTrace.set(u.traceId, list);
  }

  const client = await pool.connect();
  // UseInput carries no tenant; rows default to the 'local' tenant, so no app.tenant_id
  // GUC is set here — withTenant's GUC pattern applies only when tenant context exists.
  try {
    await client.query('BEGIN');
    const counts = await applyInTx(client, params, nodeIds, [...usedPerTrace], now);
    await client.query('COMMIT');
    return counts;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function applyInTx(
  client: PoolClient,
  params: Params,
  nodeIds: number[],
  traceEntries: Array<[number, number[]]>,
  now: number,
): Promise<FlushCounts> {
  let nodesTouched = 0;
  let edgesTouched = 0;

  // --- nodes: load state, compute dormancy from CURRENT state, record access (FR-20) ---
  const nodeRows = await client.query<NodeRow>(
    `SELECT id, access_count, recent_access, created_at
       FROM nodes WHERE id = ANY($1) AND invalid_at IS NULL`,
    [nodeIds],
  );
  for (const row of nodeRows.rows) {
    const state = asNodeState(row);
    const wasDormant = isDormantNode(baseLevel(state, now, params), params);
    const next = recordAccess(state, now, params, wasDormant);
    await client.query(`UPDATE nodes SET access_count = $2, recent_access = $3 WHERE id = $1`, [
      row.id,
      next.accessCount,
      next.recentAccess.map(fromMs),
    ]);
    nodesTouched += 1;
  }

  // --- edges: reinforce along each trace's flow paths (FR-21), once per edge per flush ---
  const edgeIds = new Set<number>();
  for (const [traceId, usedIds] of traceEntries) {
    const trace = await client.query<{ hops: Flow[] }>(`SELECT hops FROM recall_trace WHERE id = $1`, [
      traceId,
    ]);
    const flows = trace.rows[0]?.hops ?? [];
    if (flows.length === 0) continue;
    for (const nodeId of usedIds) {
      for (const edgeId of pathEdges(flows, nodeId)) edgeIds.add(edgeId);
    }
  }

  if (edgeIds.size > 0) {
    const edgeRows = await client.query<EdgeRow>(
      `SELECT id, strength, last_used_at, half_life_class
         FROM edges WHERE id = ANY($1) AND invalid_at IS NULL`,
      [[...edgeIds]],
    );
    for (const row of edgeRows.rows) {
      // Per-flush edge dedupe is the Set above: one edge hit by several nodes of the same
      // trace (or several traces) is reinforced exactly once per flush.
      const next = reinforceEdge(
        {
          strength: row.strength,
          lastUsedAt: toMs(row.last_used_at),
          halfLifeClass: row.half_life_class as HalfLifeClass,
        },
        now,
        params,
      );
      await client.query(`UPDATE edges SET strength = $2, last_used_at = $3 WHERE id = $1`, [
        row.id,
        next.strength,
        fromMs(next.lastUsedAt),
      ]);
      edgesTouched += 1;
    }
  }

  // --- used_ids append, distinct per trace (FR-19) ---
  let tracesTouched = 0;
  for (const [traceId, usedIds] of traceEntries) {
    const res = await client.query(
      `UPDATE recall_trace
          SET used_ids = (SELECT array_agg(DISTINCT e) FROM unnest(used_ids || $2::bigint[]) AS e)
        WHERE id = $1`,
      [traceId, usedIds],
    );
    tracesTouched += res.rowCount ?? 0;
  }

  return { nodes: nodesTouched, edges: edgesTouched, traces: tracesTouched };
}
