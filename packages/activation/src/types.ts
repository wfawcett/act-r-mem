// Pure ACT-R declarative-memory types (E02). Mirrors §4 / §10 shapes with no runtime config import.

export interface Params {
  decay: number; // d   0.5
  recentAccesses: number; // M   10
  minAgeDays: number; // Δt_min 0.01
  tau: number; // τ   -1.0
  noiseScale: number; // s   0.35
  dormantP: number; // P below this = dormant (0.2)
  edgeFloor: number; // w_floor 0.001
  edgeInitial: number; // w0  1.0
  edgeGain: number; // g   0.2
  halfLifeDays: Record<HalfLifeClass, number>; // { identity: 180, default: 30, incidental: 7 }
  hops: number; // H   3
  damping: number; // δ   0.7
  pruneEpsilon: number; // ε   0.0001
  maxExpanded: number; // N_max 2000
  seedK: number; // 8
  seedMinSim: number; // 0.35
  spreadWeight: number; // λ   10
  minSpread: number; // θ_min 0.02
  recallThreshold: number; // τ_A 0.5
  resultLimit: number; // k   10
  directMinSim: number; // σ_direct 0.80
  reviveExtraAccesses: number; // 2
}

export type HalfLifeClass = "identity" | "default" | "incidental";
export type Kind = "entity" | "fact" | "episode";

// NodeState: recentAccess is newest first, epoch ms.
export interface NodeState {
  accessCount: number;
  recentAccess: number[];
  createdAt: number;
}

// EdgeState: strength in [edgeFloor, edgeInitial], decay computed on read.
export interface EdgeState {
  strength: number;
  lastUsedAt: number;
  halfLifeClass: HalfLifeClass;
}

export type Flow = { hop: number; from: number; to: number; edge: number; amount: number };

// Traversal input (§10.3). Undirected adjacency: adj[u] lists every edge incident to u
// with its far endpoint `to` — spread pushes activation in both directions through one entry.
export interface Graph {
  nodes: Map<number, NodeState>;
  adj: Map<number, Array<{ id: number; to: number } & EdgeState>>;
}

export type Cue = { id: number; activation: number }; // source activation (1.0 explicit, cosine sim via vector search)

export type Nodes = Map<number, NodeState & { kind: Kind }>;
export type Activation = Map<number, number>;

// Score row output for the associative lane.
export interface ScoreRow {
  id: number;
  A: number;
  B: number;
  S: number;
}
