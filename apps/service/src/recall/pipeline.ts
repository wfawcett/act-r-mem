// E06 recall pipeline (PRD §10.5). Read-only: never reinforces state (FR-16) —
// no reinforceEdge / recordAccess anywhere here.
import {
  baseLevel,
  score,
  spread,
  type Cue,
  type Flow,
  type Graph,
  type Nodes,
  type ScoreRow,
} from '@recall/activation';
import type { RecallDeps, RecallInput, RecallResult, RecalledMemory, Lane } from './deps.js';
import { writeTrace, type TraceData } from './trace.js';

const labelNorm = (s: string): string => s.toLowerCase().trim();

const toVecLiteral = (v: number[]): string => '[' + v.join(',') + ']';

const epoch = (d: Date | string | null): number | null =>
  d === null ? null : new Date(d as string).getTime();

interface NodeRow {
  id: number;
  kind: 'entity' | 'fact' | 'episode';
  label: string;
  content: string | null;
  occurred_at: Date | string | null;
  access_count: number;
  recent_access: Date[] | string[];
  created_at: Date | string;
}

const NODE_COLS =
  'id, kind, label, content, occurred_at, access_count, recent_access, created_at';

function toNodeState(row: NodeRow) {
  return {
    kind: row.kind,
    label: row.label,
    content: row.content,
    occurredAt: row.occurred_at ? new Date(row.occurred_at as string).toISOString() : null,
    state: {
      accessCount: Number(row.access_count),
      recentAccess: (row.recent_access as (Date | string)[]).map((t) => new Date(t as string).getTime()),
      createdAt: new Date(row.created_at as string).getTime(),
    },
  };
}

async function loadNodeRows(
  db: RecallDeps['db'],
  tenant: string,
  ids: number[],
): Promise<NodeRow[]> {
  if (ids.length === 0) return [];
  const res = await db.query(
    `SELECT ${NODE_COLS} FROM nodes WHERE tenant_id = $1 AND id = ANY($2) AND invalid_at IS NULL`,
    [tenant, ids],
  );
  return res.rows as NodeRow[];
}

// Resolve one explicit label cue: by label_norm first, then aliases @>.
async function resolveLabelCue(
  db: RecallDeps['db'],
  tenant: string,
  label: string,
): Promise<number | undefined> {
  const norm = labelNorm(label);
  const byLabel = await db.query(
    `SELECT id FROM nodes
     WHERE tenant_id = $1 AND label_norm = $2 AND invalid_at IS NULL
     ORDER BY (kind = 'entity') DESC, id LIMIT 1`,
    [tenant, norm],
  );
  if (byLabel.rows.length > 0) return Number(byLabel.rows[0].id);
  const byAlias = await db.query(
    `SELECT id FROM nodes
     WHERE tenant_id = $1 AND aliases @> $2 AND invalid_at IS NULL
     ORDER BY (kind = 'entity') DESC, id LIMIT 1`,
    [tenant, JSON.stringify([label.trim()])],
  );
  if (byAlias.rows.length > 0) return Number(byAlias.rows[0].id);
  return undefined;
}

export async function recall(input: RecallInput, deps: RecallDeps): Promise<RecallResult> {
  const { db, params: p, embed } = deps;
  const tenant = input.tenant;
  const client = input.client ?? 'local';
  const now = input.now ?? Date.now();
  const limit = input.limit ?? p.resultLimit;
  const contextMaxChars = deps.contextMaxChars ?? 4000;
  const start = Date.now();

  // Step 1 — upsert the session (FR-25), idempotent.
  await db.query(
    `INSERT INTO sessions (tenant_id, id, client) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, id) DO NOTHING`,
    [tenant, input.sessionId, client],
  );

  // Step 2 — embed the query; on failure log and continue with explicit cues only.
  let queryVec: number[] | undefined;
  try {
    queryVec = await embed(input.query);
  } catch (err) {
    console.error(`[recall] embed failed, continuing with explicit cues only: ${String(err)}`);
  }

  // Step 3 — vector seed cues (weight = cosine sim).
  const cues = new Map<number, number>(); // id -> weight
  if (queryVec) {
    const seed = await db.query(
      `SELECT id, 1 - (embedding <=> $1::vector) AS sim FROM nodes
       WHERE tenant_id = $2 AND invalid_at IS NULL AND embedding IS NOT NULL
       ORDER BY embedding <=> $1 LIMIT $3`,
      [toVecLiteral(queryVec), tenant, p.seedK],
    );
    for (const row of seed.rows as { id: string; sim: number }[]) {
      const sim = Number(row.sim);
      if (sim >= p.seedMinSim) cues.set(Number(row.id), sim);
    }
  }

  // Step 4 — resolve explicit cues (label_norm, then aliases @>) and merge all at weight 1.0.
  const explicitIds: number[] = [];
  for (const { id, label } of input.explicitCues) {
    let nodeId = id;
    if (nodeId === undefined && label !== undefined) {
      nodeId = await resolveLabelCue(db, tenant, label);
    }
    if (nodeId !== undefined) {
      cues.set(nodeId, 1.0); // explicit cues always merge at weight 1.0 (FR-12)
      explicitIds.push(nodeId);
    }
  }

  const cueIds = [...cues.keys()];
  const cueWeights = cueIds.map((id) => cues.get(id) as number);

  // Steps 5 — load the graph hop by hop from the cue layer, ≤ hops queries,
  // stopping at maxExpanded nodes.
  const adj: Graph['adj'] = new Map();
  const seenEdges = new Set<number>();
  const nodeIds = new Set<number>(cueIds);
  let frontier = [...cueIds];
  for (let hop = 1; hop <= p.hops && frontier.length > 0; hop++) {
    if (nodeIds.size >= p.maxExpanded) break;
    const edgeRes = await db.query(
      `SELECT id, src, dst, half_life_class, strength, last_used_at FROM edges
       WHERE tenant_id = $1 AND invalid_at IS NULL AND (src = ANY($2::bigint[]) OR dst = ANY($2::bigint[]))`,
      [tenant, frontier],
    );
    const fresh: number[] = [];
    for (const e of edgeRes.rows as {
      id: string;
      src: string;
      dst: string;
      half_life_class: 'identity' | 'default' | 'incidental';
      strength: number;
      last_used_at: Date | string;
    }[]) {
      const edgeId = Number(e.id);
      if (seenEdges.has(edgeId)) continue;
      seenEdges.add(edgeId);
      const src = Number(e.src);
      const dst = Number(e.dst);
      const entry = {
        id: edgeId,
        to: dst,
        strength: Number(e.strength),
        lastUsedAt: new Date(e.last_used_at as string).getTime(),
        halfLifeClass: e.half_life_class,
      };
      if (!adj.has(src)) adj.set(src, []);
      adj.get(src)?.push(entry);
      if (!adj.has(dst)) adj.set(dst, []);
      adj.get(dst)?.push({ ...entry, to: src });
      if (!nodeIds.has(dst)) {
        nodeIds.add(dst);
        fresh.push(dst);
      }
    }
    frontier = fresh;
  }

  // Fetch node rows for every involved id (cues + reached).
  const rows = await loadNodeRows(db, tenant, [...nodeIds]);
  const nodes: Nodes = new Map();
  const meta = new Map<number, ReturnType<typeof toNodeState>>();
  for (const row of rows) {
    const n = toNodeState(row);
    nodes.set(row.id, { ...n.state, kind: n.kind });
    meta.set(row.id, n);
  }

  // Step 6 — spreading activation then associative scoring.
  const g: Graph = { nodes, adj };
  const cueList: Cue[] = cueIds.map((id) => ({ id, activation: cues.get(id) as number }));
  const flows: Flow[] = spread(g, cueList, now, p);
  const activation = new Map<number, number>();
  for (const f of flows) activation.set(f.to, (activation.get(f.to) ?? 0) + f.amount);
  const scored: ScoreRow[] = score(nodes, activation, now, p).slice(0, limit);

  // Step 7 — exposure lane: valid neighbors of each reached episode, dormant included (FR-13).
  const present = new Set<number>(scored.map((r) => r.id));
  const exposure: RecalledMemory[] = [];
  const episodes = [...nodes.entries()]
    .filter(([, n]) => n.kind === 'episode')
    .map(([id]) => id)
    .sort((a, b) => a - b);
  for (const epId of episodes) {
    for (const e of adj.get(epId) ?? []) {
      if (present.has(e.to) || exposure.some((m) => m.id === e.to)) continue;
      const node = nodes.get(e.to);
      if (!node) continue;
      present.add(e.to);
      const m = meta.get(e.to);
      exposure.push({
        id: e.to,
        kind: node.kind,
        label: m?.label ?? '',
        content: m?.content ?? null,
        lane: 'exposure',
        activation: null,
        base_level: baseLevel(node, now, p),
        spread: null,
        occurred_at: m?.occurredAt ?? null,
        via: epId,
      });
    }
  }

  // Step 8 — direct lane: single best fact by embedding sim (FR-14).
  const direct: RecalledMemory[] = [];
  if (queryVec) {
    const best = await db.query(
      `SELECT id, 1 - (embedding <=> $1::vector) AS sim FROM nodes
       WHERE tenant_id = $2 AND kind = 'fact' AND invalid_at IS NULL AND embedding IS NOT NULL
       ORDER BY embedding <=> $1 LIMIT 1`,
      [toVecLiteral(queryVec), tenant],
    );
    if (best.rows.length > 0) {
      const { id, sim } = best.rows[0] as { id: string; sim: number };
      const nodeId = Number(id);
      if (Number(sim) >= p.directMinSim && !present.has(nodeId)) {
        const [row] = await loadNodeRows(db, tenant, [nodeId]);
        if (row) {
          present.add(nodeId);
          const n = toNodeState(row);
          direct.push({
            id: nodeId,
            kind: n.kind,
            label: n.label,
            content: n.content,
            lane: 'direct',
            activation: null,
            base_level: baseLevel(n.state, now, p),
            spread: null,
            occurred_at: n.occurredAt,
            via: null,
          });
        }
      }
    }
  }

  // Step 9 — build the §8 response (associative by A desc, then exposure, then direct)
  // and write the trace.
  const memories: RecalledMemory[] = [
    ...scored.map((r) => {
      const node = nodes.get(r.id);
      const m = meta.get(r.id);
      return {
        id: r.id,
        kind: node?.kind ?? 'entity',
        label: m?.label ?? '',
        content: m?.content ?? null,
        lane: 'associative' as Lane,
        activation: r.A,
        base_level: r.B,
        spread: r.S,
        occurred_at: m?.occurredAt ?? null,
        via: null,
      };
    }),
    ...exposure,
    ...direct,
  ];

  const lines = memories.map((m) =>
    `[${m.id}] ${m.kind} ${m.label}${m.content ? ' — ' + m.content : ''}`,
  );
  const text = lines.join('\n').slice(0, contextMaxChars);

  const traceData: TraceData = {
    tenant,
    sessionId: input.sessionId,
    client,
    query: input.query,
    cueIds,
    cueWeights,
    hops: flows,
    recalled: memories.map((m) => ({ id: m.id, lane: m.lane, A: m.activation, B: m.base_level, S: m.spread })),
    params: p,
    durationMs: Date.now() - start,
  };
  const trace_id = await writeTrace(deps, traceData);

  return { trace_id, memories, text };
}
