// In-memory graph store for the replay harness (E03 task 5). Mirrors the
// `Graph`/`Nodes` shapes from `@recall/activation` so the pure math can run
// directly, plus a key/label/alias registry and `invalidated` flags for
// superseded facts (PRD SC-12: superseded facts are excluded from every lane).
// `applyUse` applies `recordAccess` + `reinforceEdge` inline along the last
// recall's `pathEdges` (§10.6 flush semantics — no buffer/timer).
import {
  baseLevel,
  isDormantNode,
  pathEdges,
  recordAccess,
  reinforceEdge,
} from '@recall/activation';
import type { EdgeState, Flow, HalfLifeClass, Kind, NodeState, Nodes, Params } from '@recall/activation';
import type { RememberInput, ScenarioEdge, ScenarioNode } from './types.js';

interface StoreNode extends NodeState {
  kind: Kind;
  label: string;
  key: string;
  invalidated: boolean;
}

interface AdjEntry {
  id: number;
  to: number;
  strength: number;
  lastUsedAt: number;
  halfLifeClass: HalfLifeClass;
}

interface StoreEdge {
  id: number;
  from: number;
  to: number;
  predicate: string;
  strength: number;
  lastUsedAt: number;
  halfLifeClass: HalfLifeClass;
  invalidated: boolean;
}

const pairKey = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);

export class MemoryStore {
  readonly nodes: Map<number, StoreNode> = new Map();
  readonly adj: Map<number, AdjEntry[]> = new Map();
  private readonly nodeByKey = new Map<string, number>();
  private readonly nodeByLabel = new Map<string, number>();
  private readonly nodeByAlias = new Map<string, number>();
  private readonly edges = new Map<number, StoreEdge>();
  private readonly edgeByPair = new Map<string, number>();
  private readonly factBySubject = new Map<number, number>(); // subject id -> current fact node id
  private nextNodeId = 1;
  private nextEdgeId = 1;
  private lastFlows: Flow[] = [];

  constructor(
    readonly params: Params,
    readonly epochMs: number,
  ) {}

  // --- registry -------------------------------------------------------------

  resolveKey(key: string): number | undefined {
    return this.nodeByKey.get(key) ?? this.nodeByLabel.get(key) ?? this.nodeByAlias.get(key);
  }

  // --- graph construction ----------------------------------------------------

  upsertNode(node: ScenarioNode): number {
    const existing = this.nodeByKey.get(node.key);
    if (existing !== undefined) return existing;
    const id = this.nextNodeId++;
    this.nodes.set(id, {
      accessCount: node.accesses.length,
      recentAccess: [...node.accesses].sort((a, b) => b - a).map((d) => this.epochMs + d * 86_400_000),
      createdAt: this.epochMs + node.created * 86_400_000,
      kind: node.kind,
      label: node.label,
      key: node.key,
      invalidated: false,
    });
    this.nodeByKey.set(node.key, id);
    this.nodeByLabel.set(node.label, id);
    for (const alias of node.aliases) this.nodeByAlias.set(alias, id);
    return id;
  }

  upsertEdge(edge: ScenarioEdge): number {
    const from = this.requireKey(edge.from);
    const to = this.requireKey(edge.to);
    const pair = pairKey(from, to);
    const existing = this.edgeByPair.get(pair);
    if (existing !== undefined) return existing;
    const id = this.nextEdgeId++;
    const halfLifeClass = edge.half_life_class ?? 'default';
    this.edges.set(id, {
      id,
      from,
      to,
      predicate: edge.predicate,
      strength: edge.strength,
      lastUsedAt: this.epochMs + edge.lastUsed * 86_400_000,
      halfLifeClass,
      invalidated: false,
    });
    this.edgeByPair.set(pair, id);
    const entry: AdjEntry = { id, to, strength: edge.strength, lastUsedAt: this.epochMs + edge.lastUsed * 86_400_000, halfLifeClass };
    // Undirected adjacency: one entry per endpoint, each pointing at the other.
    this.adjEntry(from, to, entry);
    this.adjEntry(to, from, entry);
    return id;
  }

  private adjEntry(endpoint: number, other: number, entry: AdjEntry): void {
    const list = this.adj.get(endpoint) ?? [];
    list.push({ ...entry, to: other });
    this.adj.set(endpoint, list);
  }

  private requireKey(key: string): number {
    const id = this.resolveKey(key);
    if (id === undefined) throw new Error(`unknown node key/label/alias: ${key}`);
    return id;
  }

  // --- remember (structured only, SC-12) --------------------------------------

  rememberStructured(input: RememberInput, now: number): void {
    const s = input.structured;
    if (!s) return;
    for (const e of s.entities) {
      const existing = this.nodeByLabel.get(e.label) ?? this.resolveKey(e.label);
      if (existing !== undefined) continue;
      const id = this.nextNodeId++;
      this.nodes.set(id, {
        accessCount: 0,
        recentAccess: [],
        createdAt: now,
        kind: 'entity',
        label: e.label,
        key: e.label,
        invalidated: false,
      });
      this.nodeByKey.set(e.label, id);
      this.nodeByLabel.set(e.label, id);
      for (const alias of e.aliases ?? []) this.nodeByAlias.set(alias, id);
    }
    for (const f of s.facts) {
      const subjectId = this.resolveKey(f.subject) ?? this.createEntity(f.subject, now);
      // Contradiction: a same-subject existing fact node is superseded (SC-12).
      // The scenario declares both facts; there is no LLM judge here.
      const prior = this.factBySubject.get(subjectId);
      if (prior !== undefined) this.invalidateFact(prior);
      const id = this.nextNodeId++;
      this.nodes.set(id, {
        accessCount: 1,
        recentAccess: [now],
        createdAt: now,
        kind: 'fact',
        label: f.statement,
        key: f.statement,
        invalidated: false,
      });
      this.nodeByKey.set(f.statement, id);
      this.nodeByLabel.set(f.statement, id);
      this.factBySubject.set(subjectId, id);
      this.link(subjectId, id, 'fact', f.half_life_class ?? 'default', now);
    }
    for (const e of s.edges) {
      const from = this.resolveKey(e.from) ?? this.createEntity(e.from, now);
      const to = this.resolveKey(e.to) ?? this.createEntity(e.to, now);
      const pair = pairKey(from, to);
      const existing = this.edgeByPair.get(pair);
      if (existing !== undefined) {
        const edge = this.edges.get(existing);
        if (edge) {
          edge.lastUsedAt = now;
          for (const [nid, list] of this.adj) {
            if (nid !== from && nid !== to) continue;
            for (const a of list) if (a.id === existing) a.lastUsedAt = now;
          }
        }
        continue;
      }
      this.link(from, to, e.predicate, e.half_life_class ?? 'default', now);
    }
  }

  private createEntity(label: string, now: number): number {
    const id = this.nextNodeId++;
    this.nodes.set(id, {
      accessCount: 0,
      recentAccess: [],
      createdAt: now,
      kind: 'entity',
      label,
      key: label,
      invalidated: false,
    });
    this.nodeByKey.set(label, id);
    this.nodeByLabel.set(label, id);
    return id;
  }

  private link(from: number, to: number, predicate: string, halfLifeClass: HalfLifeClass, now: number): number {
    const pair = pairKey(from, to);
    const existing = this.edgeByPair.get(pair);
    if (existing !== undefined) return existing;
    const id = this.nextEdgeId++;
    this.edges.set(id, { id, from, to, predicate, strength: 1, lastUsedAt: now, halfLifeClass, invalidated: false });
    this.edgeByPair.set(pair, id);
    const entry: AdjEntry = { id, to, strength: 1, lastUsedAt: now, halfLifeClass };
    this.adjEntry(from, to, entry);
    this.adjEntry(to, from, entry);
    return id;
  }

  // A superseded fact node is excluded from every lane together with its
  // incident edges (SC-12).
  private invalidateFact(id: number): void {
    const node = this.nodes.get(id);
    if (node) node.invalidated = true;
    for (const [nid, list] of this.adj) {
      if (nid !== id) continue;
      for (const a of list) {
        const e = this.edges.get(a.id);
        if (e) e.invalidated = true;
      }
    }
  }

  isInvalidated(id: number): boolean {
    return this.nodes.get(id)?.invalidated ?? false;
  }

  isEdgeInvalidated(edgeId: number): boolean {
    return this.edges.get(edgeId)?.invalidated ?? false;
  }

  // --- §10.6 flush: use flows straight into the graph ---------------------------

  setLastFlows(flows: Flow[]): void {
    this.lastFlows = flows;
  }

  applyUse(ids: number[], now: number, p: Params): void {
    // Reinforce edges inline along the last trace's pathEdges, then record the
    // accesses. Edge ids are deduped across targets.
    const edgeIds = new Set<number>();
    for (const id of ids) {
      for (const e of pathEdges(this.lastFlows, id)) edgeIds.add(e);
    }
    for (const eid of edgeIds) {
      const e = this.edges.get(eid);
      if (!e || e.invalidated) continue;
      const reinforced = reinforceEdge(e, now, p);
      e.strength = reinforced.strength;
      e.lastUsedAt = reinforced.lastUsedAt;
      for (const list of this.adj.values()) {
        for (const a of list) {
          if (a.id !== eid) continue;
          a.strength = reinforced.strength;
          a.lastUsedAt = reinforced.lastUsedAt;
        }
      }
    }
    for (const id of ids) {
      const n = this.nodes.get(id);
      if (!n || n.invalidated) continue;
      const wasDormant = isDormantNode(baseLevel(n, now, p), p);
      const updated = recordAccess(n, now, p, wasDormant);
      n.accessCount = updated.accessCount;
      n.recentAccess = updated.recentAccess;
    }
  }

  // --- state reads -------------------------------------------------------------

  // Graph views for the recall pipeline (§10.5): spread/score consume these.
  nodesView(): Nodes {
    return this.nodes;
  }

  nodeState(id: number): NodeState {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown node id: ${id}`);
    return { accessCount: n.accessCount, recentAccess: [...n.recentAccess], createdAt: n.createdAt };
  }

  nodeKind(id: number): Kind {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown node id: ${id}`);
    return n.kind;
  }

  nodeLabel(id: number): string {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown node id: ${id}`);
    return n.label;
  }

  edgeState(from: number, to: number): EdgeState {
    const id = this.edgeByPair.get(pairKey(from, to));
    const e = id !== undefined ? this.edges.get(id) : undefined;
    if (!e) throw new Error(`unknown edge ${from}->${to}`);
    return { strength: e.strength, lastUsedAt: e.lastUsedAt, halfLifeClass: e.halfLifeClass };
  }

  edgeId(from: number, to: number): number | undefined {
    return this.edgeByPair.get(pairKey(from, to));
  }
}
