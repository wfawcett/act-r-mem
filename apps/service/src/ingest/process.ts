// §11.2 ingest pipeline for one queue item: redact → window → extract (skipped
// for valid structured input, FR-05) → resolve entities (FR-06/07) → create
// episodes/entities/facts → edges with `mentioned_in`/`incidental` links and
// reinforcement of existing valid (src, dst, predicate) edges → batch embed of
// new nodes (FR-08) → contradiction supersession (FR-09, §11.4) → implicit use
// for transcripts (FR-23). Transcript replay of the same
// (client, session_id, turn_index) creates no new rows (FR-10).
// All model input is redacted before any call (§11.2.1, NFR-11); nothing here
// logs raw item text or error strings.
import type { PoolClient } from 'pg';
import { RememberStructuredSchema, type RememberStructured } from './enqueue.js';
import { extractFromWindows } from './extract.js';
import { redact } from './redact.js';
import { windowTurns, type TranscriptTurn } from './window.js';
import { resolveEntities, normalizeLabel } from './resolve.js';
import type { createClient, Extraction } from '../llm/client.js';
import { withTenant } from '../db/tenant.js';
import { getParams } from '../config.js';
import type { Config } from '../config.js';

export const Constants = { entityMergeSim: 0.92, contradictionSim: 0.85 } as const;

type LlmClient = ReturnType<typeof createClient>;

export interface QueueItem {
  id: number;
  tenant_id: string;
  kind: 'remember' | 'transcript';
  client: string;
  session_id: string | null;
  payload: {
    text?: string;
    occurred_at?: string;
    structured?: RememberStructured;
    turns?: TranscriptTurn[];
  };
  status: 'pending' | 'processing' | 'done' | 'failed';
  attempts: number;
  run_after: Date;
  last_error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface ProcessDeps {
  client: LlmClient;
  config: Config;
  now?: () => Date;
}

// Reinforcement bump applied to an existing valid edge instead of duplicating it.
const REINFORCE_BUMP = 0.1;

function vectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

// --- structured input → Extraction (FR-05) ----------------------------------

function structuredToExtraction(s: RememberStructured): Extraction {
  return {
    episodes:
      s.episode === undefined
        ? []
        : [{ key: 'ep:0', label: s.episode.label, summary: s.episode.summary }],
    entities: s.entities.map((e, i) => ({
      key: `ent:${i}`,
      label: e.label,
      aliases: e.aliases,
    })),
    facts: s.facts.map((f, i) => ({
      key: `fact:${i}`,
      subject_key: f.subject,
      statement: f.statement,
      half_life_class: f.half_life_class ?? 'default',
    })),
    edges: s.edges.map((e, i) => ({
      from_key: e.from,
      to_key: e.to,
      predicate: e.predicate,
      half_life_class: e.half_life_class ?? 'default',
    })),
  };
}

// --- helpers over the transaction client ------------------------------------

async function upsertEdge(
  db: PoolClient,
  tenantId: string,
  src: number,
  dst: number,
  predicate: string,
  halfLifeClass: string,
  now: Date,
  source: string,
): Promise<void> {
  if (src === dst) return;
  // Unique partial index (tenant, src, dst, predicate) WHERE invalid_at IS NULL:
  // an existing valid edge is reinforced (strength bump + last_used_at), never
  // duplicated.
  await db.query(
    `INSERT INTO edges (tenant_id, src, dst, predicate, half_life_class, strength,
                        last_used_at, source)
     VALUES ($1, $2, $3, $4, $5, 1.0, $6, $7)
     ON CONFLICT (tenant_id, src, dst, predicate) WHERE invalid_at IS NULL
     DO UPDATE SET strength = LEAST(1.0, edges.strength + $8), last_used_at = EXCLUDED.last_used_at`,
    [tenantId, src, dst, predicate, halfLifeClass, now, source, REINFORCE_BUMP],
  );
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

/** FR-23 reinforcement: bump every valid edge touching the used node. */
async function reinforceNodeEdges(db: PoolClient, nodeId: number, at: Date): Promise<void> {
  await db.query(
    `UPDATE edges
     SET strength = LEAST(1.0, strength + $2), last_used_at = $3
     WHERE (src = $1 OR dst = $1) AND invalid_at IS NULL`,
    [nodeId, REINFORCE_BUMP, at],
  );
}

/** Turn indexes of this (client, session_id) that already have episodes (FR-10). */
async function alreadyIngestedTurns(
  db: PoolClient,
  tenantId: string,
  item: QueueItem,
): Promise<Set<number>> {
  if (item.session_id === null) return new Set();
  const rows = await db.query<{ idx: (number | string)[] | null }>(
    `SELECT metadata->'turn_indexes' AS idx FROM nodes
     WHERE tenant_id = $1 AND kind = 'episode' AND invalid_at IS NULL
       AND metadata->>'client' = $2 AND metadata->>'session_id' = $3`,
    [tenantId, item.client, item.session_id],
  );
  const out = new Set<number>();
  for (const row of rows.rows) {
    for (const v of row.idx ?? []) out.add(Number(v));
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- main entry -------------------------------------------------------------

export async function processItem(
  item: QueueItem,
  deps: ProcessDeps,
): Promise<'done' | 'retry' | 'failed'> {
  const now = deps.now ?? (() => new Date());
  const tenantId = item.tenant_id;

  // Payload shape is fixed per kind; a mismatch can never be retried into
  // validity, so this is 'failed' rather than a throw (which means 'retry').
  if (item.kind === 'remember' && typeof item.payload.text !== 'string') return 'failed';
  if (item.kind === 'transcript' && !Array.isArray(item.payload.turns)) return 'failed';

  await withTenant(tenantId, async (db) => {
    // --- 1. Redact (§11.2.1): before any model call ------------------------
    const redactedTurns = item.payload.turns?.map((t) => ({ ...t, content: redact(t.content) }));

    // --- 2. Window: transcripts on turn boundaries, remember one window ----
    const windows: { text: string; earliestAt: Date; indexes: number[] }[] = [];
    if (item.kind === 'remember') {
      const occurred = item.payload.occurred_at;
      const at = occurred !== undefined ? new Date(occurred) : item.created_at;
      windows.push({
        text: redact(item.payload.text as string),
        earliestAt: Number.isNaN(at.getTime()) ? item.created_at : at,
        indexes: [],
      });
    } else if (redactedTurns !== undefined) {
      for (const w of windowTurns(redactedTurns, deps.config.extractWindowChars)) {
        windows.push({
          text: w.map((t) => t.content).join(' '),
          earliestAt: earliestTurnAt(w),
          indexes: w.map((t) => t.index),
        });
      }
    }

    // --- FR-10: drop windows whose turns were already ingested -------------
    if (item.kind === 'transcript' && item.session_id !== null) {
      const already = await alreadyIngestedTurns(db, tenantId, item);
      const kept = windows.filter((w) => !w.indexes.some((idx) => already.has(idx)));
      if (kept.length === 0) return; // identical re-send: no new rows
      windows.length = 0;
      windows.push(...kept);
    }

    // --- 3. Extract (skipped for valid structured input, FR-05) ------------
    const structuredCheck = RememberStructuredSchema.safeParse(item.payload.structured);
    const extraction = structuredCheck.success
      ? structuredToExtraction(structuredCheck.data)
      : await extractFromWindows(
          windows.map((w) => w.text),
          deps.client,
          `ingest:${item.id}`,
        );

    // §11.5: nothing worth keeping ⇒ done; the caller marks the row done with
    // `{empty: true}` metadata. Commit (no-op) and return.
    if (
      extraction.entities.length === 0 &&
      extraction.facts.length === 0 &&
      extraction.episodes.length === 0
    ) {
      return;
    }

    // --- 4. Resolve entities (FR-06/07) ------------------------------------
    // Label for each key: explicit entity entries, then fact subjects and edge
    // endpoints, which may reference entities that were not listed explicitly
    // (those labels are resolved as entities too).
    const labelByKey = new Map<string, string>();
    for (const e of extraction.entities) labelByKey.set(e.key, e.label);
    const extraLabels: string[] = [];
    for (const f of extraction.facts) {
      if (!labelByKey.has(f.subject_key)) {
        labelByKey.set(f.subject_key, f.subject_key);
        extraLabels.push(f.subject_key);
      }
    }
    for (const e of extraction.edges) {
      for (const endpoint of [e.from_key, e.to_key]) {
        if (!labelByKey.has(endpoint)) {
          labelByKey.set(endpoint, endpoint);
          extraLabels.push(endpoint);
        }
      }
    }
    const resolved = await resolveEntities(
      [...extraction.entities.map((e) => e.label), ...extraLabels],
      tenantId,
      deps.client,
      { at: item.created_at, db },
    );
    const nodeIdForKey = (key: string): number | undefined =>
      resolved.get(labelByKey.get(key) ?? key);

    // --- 5. Create episodes (occurred_at from extraction, else earliest ----
    // turn time of the window, else the item's time) -------------------------
    const episodeIds = new Map<string, number>();
    for (let i = 0; i < extraction.episodes.length; i += 1) {
      const ep = extraction.episodes[i];
      if (ep === undefined) continue;
      const parsed = ep.occurred_at === undefined ? undefined : new Date(ep.occurred_at);
      const occurredAt =
        parsed !== undefined && !Number.isNaN(parsed.getTime())
          ? parsed
          : (windows[i]?.earliestAt ?? item.created_at);
      const rows = await db.query<{ id: string | number }>(
        `INSERT INTO nodes (tenant_id, kind, label, label_norm, content, occurred_at,
                            access_count, recent_access, sources, metadata)
         VALUES ($1, 'episode', $2, $3, $4, $5, 1, ARRAY[$6::timestamptz], ARRAY[$7], $8::jsonb)
         RETURNING id`,
        [
          tenantId,
          ep.label,
          normalizeLabel(ep.label),
          ep.summary,
          occurredAt,
          item.created_at,
          item.client,
          JSON.stringify(
            item.kind === 'transcript' && item.session_id !== null
              ? {
                  client: item.client,
                  session_id: item.session_id,
                  turn_indexes: windows[i]?.indexes ?? [],
                }
              : { source_client: item.client },
          ),
        ],
      );
      const row = rows.rows[0];
      if (row === undefined) throw new Error('processItem: episode INSERT returned no row');
      episodeIds.set(ep.key, Number(row.id));
    }

    // --- 5b. Create facts ----------------------------------------------------
    const newFacts: { id: number; statement: string }[] = [];
    const factIds = new Map<string, number>();
    for (const f of extraction.facts) {
      const subjectId = nodeIdForKey(f.subject_key);
      if (subjectId === undefined) continue;
      const dup = await db.query<{ id: string | number }>(
        `SELECT f.id FROM nodes f
         JOIN edges e ON e.src = f.id AND e.predicate = 'about' AND e.invalid_at IS NULL
         WHERE f.tenant_id = $1 AND f.kind = 'fact' AND f.invalid_at IS NULL
           AND lower(trim(f.content)) = lower(trim($2)) AND e.dst = $3
         LIMIT 1`,
        [tenantId, f.statement, subjectId],
      );
      if (dup.rows.length > 0) {
        // FR-10: an identical fact about the same subject already exists.
        factIds.set(f.key, Number(dup.rows[0]?.id));
        continue;
      }
      const label = f.statement.slice(0, 80);
      const inserted = await db.query<{ id: string | number }>(
        `INSERT INTO nodes (tenant_id, kind, label, label_norm, content,
                            access_count, recent_access, sources)
         VALUES ($1, 'fact', $2, $3, $4, 1, ARRAY[$5::timestamptz], ARRAY[$6])
         RETURNING id`,
        [tenantId, label, normalizeLabel(label), f.statement, item.created_at, item.client],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error('processItem: fact INSERT returned no row');
      const factId = Number(row.id);
      factIds.set(f.key, factId);
      newFacts.push({ id: factId, statement: f.statement });
      // Facts link to their subject entity with predicate 'about' (§11.4
      // "valid facts linked to S").
      await upsertEdge(db, tenantId, factId, subjectId, 'about', f.half_life_class, now(), item.client);
    }

    // --- 6. Link: extraction edges + mentioned_in/incidental links ---------
    for (const e of extraction.edges) {
      const src = nodeIdForKey(e.from_key);
      const dst = nodeIdForKey(e.to_key);
      if (src === undefined || dst === undefined) continue;
      await upsertEdge(db, tenantId, src, dst, e.predicate, e.half_life_class, now(), item.client);
    }
    for (const episodeId of episodeIds.values()) {
      // Every entity and fact mentioned in an episode links to it with
      // predicate `mentioned_in`, class `incidental` (§11.2 step 6).
      for (const entityId of new Set(resolved.values())) {
        await upsertEdge(db, tenantId, episodeId, entityId, 'mentioned_in', 'incidental', now(), item.client);
      }
      for (const factId of new Set(factIds.values())) {
        await upsertEdge(db, tenantId, episodeId, factId, 'mentioned_in', 'incidental', now(), item.client);
      }
    }

    // --- 7. Embed every new node (FR-08): `label + '\n' + content` ---------
    const toEmbed: { id: number; text: string }[] = [];
    for (const [epKey, id] of episodeIds) {
      const ep = extraction.episodes.find((e) => e.key === epKey);
      if (ep !== undefined) toEmbed.push({ id, text: `${ep.label}\n${ep.summary}` });
    }
    for (const nf of newFacts) toEmbed.push({ id: nf.id, text: `fact\n${nf.statement}` });
    await Promise.all(
      toEmbed.map(async (n) => {
        const vector = await deps.client.embed(n.text, { requestId: `ingest:${item.id}` });
        await db.query(`UPDATE nodes SET embedding = $2::vector WHERE id = $1`, [n.id, vectorLiteral(vector)]);
      }),
    );

    // --- 8. Contradiction check (FR-09, §11.4) ------------------------------
    for (const nf of newFacts) {
      const own = await db.query<{ embedding: string | null }>(
        `SELECT embedding::text AS embedding FROM nodes WHERE id = $1`,
        [nf.id],
      );
      const vec = own.rows[0]?.embedding;
      if (vec === null || vec === undefined) continue;
      const candidates = await db.query<{ id: string | number; content: string | null }>(
        `SELECT f.id, f.content FROM nodes f
         JOIN edges e ON e.src = f.id AND e.predicate = 'about' AND e.invalid_at IS NULL
         WHERE f.tenant_id = $1 AND f.kind = 'fact' AND f.invalid_at IS NULL
           AND f.id <> $2 AND f.embedding IS NOT NULL
           AND 1 - (f.embedding <=> $3::vector) >= $4`,
        [tenantId, nf.id, vec, Constants.contradictionSim],
      );
      for (const cand of candidates.rows) {
        if (cand.content === null) continue;
        const contradicts = await deps.client.judge(nf.statement, cand.content, {
          requestId: `ingest:${item.id}`,
        });
        if (!contradicts) continue;
        const ts = now();
        await db.query(`UPDATE nodes SET invalid_at = $2, superseded_by = $3 WHERE id = $1`, [
          cand.id,
          ts,
          nf.id,
        ]);
        await db.query(
          `UPDATE edges SET invalid_at = $2 WHERE (src = $1 OR dst = $1) AND invalid_at IS NULL`,
          [cand.id, ts],
        );
      }
    }

    // --- 9. Implicit use for transcripts (FR-23) ---------------------------
    if (item.kind === 'transcript' && item.session_id !== null && redactedTurns !== undefined) {
      await implicitUse(db, tenantId, item.session_id, redactedTurns, now);
    }
  });

  return 'done';
}

function earliestTurnAt(window: TranscriptTurn[]): Date {
  const times = window.map((t) => new Date(t.at).getTime()).filter((n) => !Number.isNaN(n));
  return times.length === 0 ? new Date() : new Date(Math.min(...times));
}

/** FR-23: recalled nodes whose label appears in a later assistant turn are used. */
async function implicitUse(
  db: PoolClient,
  tenantId: string,
  sessionId: string,
  turns: TranscriptTurn[],
  now: () => Date,
): Promise<void> {
  const traces = await db.query<{ id: string | number; at: Date; recalled: { id: number }[]; used_ids: number[] }>(
    `SELECT id, at, recalled, used_ids FROM recall_trace
     WHERE tenant_id = $1 AND session_id = $2`,
    [tenantId, sessionId],
  );
  const nodeIds = new Set<number>();
  for (const trace of traces.rows) {
    for (const r of trace.recalled ?? []) if (typeof r.id === 'number') nodeIds.add(r.id);
    for (const id of trace.used_ids ?? []) nodeIds.add(Number(id));
  }
  if (nodeIds.size === 0) return;
  const labels = await db.query<{ id: string | number; label: string }>(
    `SELECT id, label FROM nodes WHERE id = ANY($1)`,
    [[...nodeIds]],
  );
  const assistants = turns.filter((t) => t.role === 'assistant');
  for (const node of labels.rows) {
    const pattern = new RegExp(`\\b${escapeRegex(node.label.toLowerCase())}\\b`);
    for (const trace of traces.rows) {
      const after = assistants.filter((t) => new Date(t.at).getTime() > new Date(trace.at).getTime());
      if (after.some((t) => pattern.test(t.content.toLowerCase()))) {
        const at = now();
        await recordAccess(db, Number(node.id), at);
        await reinforceNodeEdges(db, Number(node.id), at);
        break; // one access per node per item
      }
    }
  }
}
