// FR-06/FR-07: entity resolution during ingest processing.
// Per label the resolution order is: exact `label_norm` → alias membership among
// valid entities → embedding cosine ≥ `entityMergeSim` (embedding computed from
// the label). A similarity match adds the new label as an alias on the existing
// entity. Every match records one access at `opts.at` (the queue item's
// `created_at`): `access_count + 1`, `recent_access = array_prepend(at, …)`
// trimmed to `params.recentAccesses`. Runs inside the caller's transaction
// client (the `db` PoolClient from `withTenant`); this module never opens its
// own transaction.
import type { PoolClient } from 'pg';
import { getParams } from '../config.js';
import type { createClient } from '../llm/client.js';

// PRD §11 merge threshold (mirrored by `Constants.entityMergeSim` in process.ts).
export const ENTITY_MERGE_SIM = 0.92;

type LlmClient = ReturnType<typeof createClient>;

export interface ResolveOptions {
  /** Access timestamp: the queue item's `created_at` (FR-07). */
  at: Date;
  /** Caller's transaction client (`withTenant`). */
  db: PoolClient;
}

export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function vectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

async function recordAccess(db: PoolClient, nodeId: number, at: Date): Promise<void> {
  const maxRecent = getParams().recentAccesses;
  await db.query(
    `UPDATE nodes
     SET access_count = access_count + 1,
         recent_access = (array_prepend($2::timestamptz, recent_access))[1:$3]
     WHERE id = $1`,
    [nodeId, at, maxRecent],
  );
}

async function findByExact(
  db: PoolClient,
  tenantId: string,
  labelNorm: string,
): Promise<number | null> {
  const rows = await db.query<{ id: string | number }>(
    `SELECT id FROM nodes
     WHERE tenant_id = $1 AND kind = 'entity' AND invalid_at IS NULL AND label_norm = $2
     LIMIT 1`,
    [tenantId, labelNorm],
  );
  const row = rows.rows[0];
  return row === undefined ? null : Number(row.id);
}

async function findByAlias(
  db: PoolClient,
  tenantId: string,
  labelNorm: string,
): Promise<number | null> {
  const rows = await db.query<{ id: string | number }>(
    `SELECT id FROM nodes
     WHERE tenant_id = $1 AND kind = 'entity' AND invalid_at IS NULL
       AND EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(trim(a)) = $2)
     LIMIT 1`,
    [tenantId, labelNorm],
  );
  const row = rows.rows[0];
  return row === undefined ? null : Number(row.id);
}

async function addAlias(db: PoolClient, nodeId: number, aliasNorm: string): Promise<void> {
  // The alias is stored normalized; skip when the entity already carries it.
  await db.query(
    `UPDATE nodes
     SET aliases = CASE WHEN $2 = ANY(aliases) THEN aliases ELSE aliases || $2 END
     WHERE id = $1`,
    [nodeId, aliasNorm],
  );
}

/**
 * Resolve each label to a node id (existing entity or newly created one).
 * Returns a map from the original label string to the node id. Duplicate
 * normalized labels are resolved once and share the same id.
 */
export async function resolveEntities(
  labels: string[],
  tenantId: string,
  llm: LlmClient,
  opts: ResolveOptions,
): Promise<Map<string, number>> {
  const { db, at } = opts;
  const resolved = new Map<string, number>(); // original label → node id
  const byNorm = new Map<string, number>(); // label_norm → node id (dedupe within this call)

  for (const label of labels) {
    const norm = normalizeLabel(label);
    if (norm === '') throw new Error('resolveEntities: empty label');
    const known = byNorm.get(norm);
    if (known !== undefined) {
      resolved.set(label, known);
      continue;
    }

    let nodeId: number | null = await findByExact(db, tenantId, norm);
    if (nodeId === null) nodeId = await findByAlias(db, tenantId, norm);

    if (nodeId === null) {
      // Embedding similarity stage: the candidate comes from the hnsw index on
      // live entities; the cosine must reach `entityMergeSim` to merge.
      const vector = await llm.embed(label, { requestId: `resolve:${norm}` });
      const candidates = await db.query<{ id: string | number; sim: string | number }>(
        `SELECT id, 1 - (embedding <=> $2::vector) AS sim
         FROM nodes
         WHERE tenant_id = $1 AND kind = 'entity' AND invalid_at IS NULL AND embedding IS NOT NULL
         ORDER BY embedding <=> $2::vector
         LIMIT 1`,
        [tenantId, vectorLiteral(vector)],
      );
      const candidate = candidates.rows[0];
      if (candidate !== undefined && Number(candidate.sim) >= ENTITY_MERGE_SIM) {
        nodeId = Number(candidate.id);
        // FR-06: a similarity match adds the new label as an alias on the
        // existing entity (unless it would duplicate the entity key).
        const keyRows = await db.query<{ label_norm: string }>(
          `SELECT label_norm FROM nodes WHERE id = $1`,
          [nodeId],
        );
        const existing = keyRows.rows[0];
        if (existing === undefined) throw new Error(`resolveEntities: node ${nodeId} disappeared`);
        if (existing.label_norm !== norm) await addAlias(db, nodeId, norm);
        // FR-07: a similarity match is still a match — record one access.
        await recordAccess(db, nodeId, at);
      } else {
        // New entity: created with one access at the item's `created_at`.
        const inserted = await db.query<{ id: string | number }>(
          `INSERT INTO nodes (tenant_id, kind, label, label_norm, embedding, access_count, recent_access)
           VALUES ($1, 'entity', $2, $3, $4::vector, 1, ARRAY[$5::timestamptz])
           RETURNING id`,
          [tenantId, label, norm, vectorLiteral(vector), at],
        );
        const row = inserted.rows[0];
        if (row === undefined) throw new Error('resolveEntities: INSERT INTO nodes returned no row');
        nodeId = Number(row.id);
      }
    } else {
      // FR-07: every match records one access at the item's `created_at`.
      await recordAccess(db, nodeId, at);
    }

    byNorm.set(norm, nodeId);
    resolved.set(label, nodeId);
  }
  return resolved;
}
