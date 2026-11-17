# Recall: ACT-R Memory Service PRD

Nov 16, 2026 · @William Fawcett

## 1. Overview

Recall is a self-hosted memory service that gives AI agents human-like long-term memory: memories strengthen with use, fade with time, and come back when several weak cues converge. It runs in a homelab, exposes MCP tools and HTTP hook endpoints, and serves Claude Code, Hermes and omp from one shared store.

### 1.1 Problem

- Each agent client keeps its own memory, or none. Facts told to one client are unknown to the others.
- Typical agent memory is flat vector RAG. Everything stored is equally retrievable forever, so stale and trivial items compete with important ones.
- Similarity search finds text that looks like the query. It does not follow associations: "Todd called about Italy last Thursday" should surface "we had spaghetti that night" even though the query never mentions food.
- Small local models do not reliably call memory tools mid-task, so tool-driven memory loses data and adds latency.

### 1.2 Goals

1. **G1. Cognitively grounded recall.** Rank and gate recall with ACT-R declarative memory math: base-level activation from frequency and recency, plus spreading activation from current cues with a fan penalty.
2. **G2. Graceful forgetting.** Unused memories fade below the recall threshold but are never deleted. Edge weights have a floor of 0.001. A direct, specific question still retrieves a faded fact.
3. **G3. Associative, multi-hop recall.** Activation spreads 2 to 3 hops through a knowledge graph of entities, facts and episodes, so converging cues surface memories that similarity search misses.
4. **G4. Zero added lag on the hot path.** Writes and reinforcement are asynchronous. The only synchronous operation is recall, and it is prefetched at session start.
5. **G5. One memory across clients.** Claude Code, Hermes and omp read and write the same store, with each write tagged by source client.
6. **G6. Visible memory.** A web UI renders the memory graph as a 3D brain, shows a detail card per node, replays recall sessions, and time-lapses decay.
7. **G7. A clean seam for a Rust port.** All activation math lives in one pure module with no I/O, so it can later move into a Postgres extension without touching callers.

### 1.3 Success measures

- The replay scenario suite in section 15 passes, including the convergent-cue scenario and the dormant explicit-recall scenario.
- Recall latency meets the targets in section 14 with a store of at least 10,000 nodes.
- A memory written from one client is returned by recall in another client.
- No client session waits on a write: `remember`, `use` and transcript ingest return before any embedding or extraction work starts.

### 1.4 How to read this PRD

Requirements are numbered (`FR-xx`, `NFR-xx`) so they can be turned into tickets one to one. Each FR names its phase (P1 prototype, P2 multi-tenancy, P3 Rust extension) and its acceptance criteria. Where a value is marked *initial*, it is a starting point for tuning with the replay harness, not a validated constant. Decisions already made are stated as decisions; anything undecided is in section 18.

## 2. Scope

### 2.1 In scope

- A single TypeScript service (Node.js) that hosts: the MCP server, the HTTP API for client hooks and the UI, the background ingest worker, the reinforcement buffer, and the static UI bundle.
- Postgres with the pgvector extension as the only datastore and the only queue.
- Embeddings and extraction through the existing homelab LiteLLM proxy, backed by local models.
- Integrations for three clients: Claude Code, Hermes, omp.
- A replay harness and scenario suite that drive the activation math with an injected clock.
- A React 3D brain UI with node cards, session playback and a decay time-lapse.
- Phase 2: multi-tenancy with row-level security and per-tenant tokens.
- Phase 3: a Rust Postgres extension (pgrx) that implements the activation functions.

### 2.2 Out of scope

- ChatGPT and any client that cannot reach a LAN MCP server.
- Public internet exposure, SSO, OAuth. Phase 1 is LAN or Tailscale only.
- Managed cloud databases. The RDS and pg\_tle path is not needed because the homelab is self-hosted.
- ACT-R production rules, buffers, perceptual and motor modules. Only the subsymbolic declarative memory layer is used.
- Retrieval noise. ACT-R's noise term is set to zero so results are repeatable.
- Redis, Kafka, or any separate queue or cache.
- A graph database (Neo4j, Apache AGE). Graph traversal is done in TypeScript over rows loaded from Postgres.
- Importing memory from other products.

### 2.3 Constraints

- **Language:** TypeScript on Node.js for the service and UI. Rust only in phase 3, only for the extension.
- **Footprint:** prefer existing libraries; no custom framework. Every new dependency needs a reason in the PR.
- **Clock:** every time-dependent function takes `now` as a parameter. No direct `Date.now()` calls inside the math module.
- **Determinism:** the math module has no randomness and no I/O. Same inputs, same outputs.
- **Data:** personal memory, not healthcare data. No HIPAA requirements apply.

## 3. Glossary

| Term | Meaning in this PRD |
| --- | --- |
| Node | One memory unit. Kind is `entity`, `fact` or `episode`. |
| Entity | A thing with a name: a person, place, project, tool, food. Example: Todd, Italy, pgvector. |
| Fact | A single statement about one or more entities. Example: "Favorite color is blue". |
| Episode | An event bound to a time: a call, a dinner, a debugging session. Links the entities and facts that occurred together. |
| Edge | A typed association between two nodes, with a predicate ("with", "about", "ate") and a strength. |
| Access | One recorded use of a node or edge, stored as a timestamp. |
| Base level (B) | ACT-R base-level activation of a node, computed from its access timestamps. Log-odds scale, typically -4 to +3. |
| Recall probability (P) | Logistic transform of B against the threshold tau. Used for display and gating, 0 to 1. |
| Edge strength (w) | Association strength of an edge, 0.001 to 1.0, decaying over time and reinforced by use. |
| Floor | The minimum edge strength, 0.001. An edge at the floor is dormant but still exists and can be traversed. |
| Dormant | A node whose P is below 0.2, or an edge at or near the floor. Not returned by associative recall unless reached by convergence or exposed by a recalled episode. |
| Cue | A node that seeds spreading activation for a recall, chosen by vector search on the query or passed explicitly. |
| Fan | The number of edges on a node. Activation leaving a node is divided by its fan. |
| Spread (S) | Activation a node receives from cues through 1 to 3 hops in one recall. |
| Total activation (A) | B plus weighted spread. Decides whether a node is recalled. |
| Exposure | Second recall phase: a recalled episode returns all its edges and neighbors, including dormant ones. |
| Explicit recall | A direct lookup for a specific fact that ignores the threshold, used when associative recall returns nothing relevant. |
| Use | A signal that a recalled memory was actually used in an answer. The only thing that reinforces. |
| Trace | A record of one recall: cues, per-hop flows, recalled IDs, used IDs. Drives UI playback. |
| Superseded | A fact or edge replaced by a contradicting one. Closed with `invalid_at`, never deleted. |
| Tenant | The owner of a memory store. In P2 one tenant equals one person. |
| Source | The client that wrote a memory: `claude-code`, `hermes`, `omp`, `manual`. |

## 4. Memory model

A node is recalled when its total activation, base level plus weighted spread from the current cues, crosses a threshold. Node strength follows ACT-R base-level learning; edge strength follows lazy exponential decay with a floor. All formulas below live in `packages/activation` and nowhere else.

### 4.1 Node base level

Every access of a node (creation, mention at ingest, `use`, fetch by id) adds one timestamp. Base level combines frequency and recency: each access contributes a trace that decays as a power function of its age, and the traces sum.

```latex
B_i(t) = \ln\left( \sum_{j=1}^{m} \Delta t_j^{-d} + \frac{(n-m)\left(L^{1-d} - \Delta t_m^{1-d}\right)}{(1-d)\left(L - \Delta t_m\right)} \right)
```

- `n` = total access count; `m` = number of stored recent timestamps (at most `M`, the newest first); `Δt_j` = age of access j in days, clamped to at least `Δt_min`; `L` = age of the node since creation in days; `d` = decay.
- The second term is the hybrid approximation of the n - m older accesses that are not stored (Petrov 2006). When n = m it is zero.
- If `L` minus `Δt_m` is below `Δt_min`, drop the second term.

```latex
P_i = \frac{1}{1 + e^{-(B_i - \tau)/s}}
```

P is the recall probability used for display and for the dormant state. Retrieval noise is zero.

### 4.2 Edge strength

Edges store `strength` and `last_used_at`. Decay is computed on read, never by a scheduled job.

```latex
w_{eff}(t) = \max\left(w_{floor},\ w \cdot 0.5^{(t - t_{last})/h}\right)
```

On reinforcement, decay is folded in first, then a diminishing gain is applied, so a burst of uses in one session gains less than the same uses spread out:

```latex
w' = \min\left(1,\ w_{eff} + g\,(1 - w_{eff})\right), \qquad t_{last}' = t
```

New edges start at `w0`. Half-life `h` is set per predicate class (section 4.5), so identity facts fade slower than incidental mentions.

### 4.3 Spreading activation and fan

Cues are seeded with source activation `W_j`: 1.0 for cues passed explicitly, cosine similarity for cues found by vector search. Activation moves hop by hop. Leaving node u toward neighbor v, the amount is divided by u's fan, so busy nodes spread thin (ACT-R fan effect):

```latex
S_v \mathrel{+}= \frac{a_u \cdot w_{eff}(u,v) \cdot \delta}{\text{fan}(u)}
```

- Up to `H` hops. Cues never receive activation. Flows below `ε` are pruned. At most `N_max` nodes are expanded per recall.
- Superseded edges (`invalid_at` set) are skipped. Dormant edges at the floor are traversed but carry almost nothing.
- Spread is multi-hop, which goes past ACT-R's single-step spread. This is deliberate (G3).

### 4.4 Total activation and recall gates

```latex
A_i = B_i + \lambda S_i
```

Recall runs in three lanes and merges results by node id:

1. **Associative:** node i is recalled when `S_i ≥ θ_min` and `A_i ≥ τ_A`. Ranked by A, top `k`.
2. **Exposure:** every recalled `episode` node also returns all its valid edges and neighbors, dormant ones included, as details. This is how a faded detail (spaghetti) returns as part of a recalled event (Thursday dinner).
3. **Direct:** a vector search over `fact` nodes that ignores activation. The best fact is returned when its similarity is at least `σ_direct` and it is not already in the result. This makes a faded fact retrievable by a specific question ("what is my favorite color") while broad queries about colors do not surface it. It mirrors ACT-R work on a familiarity-dependent retrieval threshold.

### 4.5 Parameters

All values are *initial* and live in one config object with these names. The replay harness is the tool for tuning them.

| Name | Symbol | Initial | Unit | Notes |
| --- | --- | --- | --- | --- |
| `decay` | d | 0.5 | none | ACT-R standard decay |
| `recentAccesses` | M | 10 | count | stored timestamps per node |
| `minAgeDays` | Δt\_min | 0.01 | days | about 15 minutes, avoids infinity |
| `tau` | τ | -1.0 | log-odds | recall probability midpoint |
| `noiseScale` | s | 0.35 | log-odds | shapes P only; no sampling |
| `dormantP` |  | 0.2 | probability | P below this = dormant |
| `edgeFloor` | w\_floor | 0.001 | strength | never lower |
| `edgeInitial` | w0 | 1.0 | strength | new edge |
| `edgeGain` | g | 0.2 | fraction | per reinforcement |
| `halfLifeDays.identity` | h | 180 | days | name, relation, stated preference |
| `halfLifeDays.default` | h | 30 | days | most predicates |
| `halfLifeDays.incidental` | h | 7 | days | passing mentions |
| `hops` | H | 3 | hops |  |
| `damping` | δ | 0.7 | fraction | per hop |
| `pruneEpsilon` | ε | 0.0001 | activation |  |
| `maxExpanded` | N\_max | 2000 | nodes | per recall |
| `seedK` |  | 8 | nodes | vector-search cues per query |
| `seedMinSim` |  | 0.35 | cosine | ignore weaker cues |
| `spreadWeight` | λ | 10 | none | scales S onto the B scale |
| `minSpread` | θ\_min | 0.02 | activation | needs some context |
| `recallThreshold` | τ\_A | 0.5 | log-odds |  |
| `resultLimit` | k | 10 | nodes | associative lane |
| `directMinSim` | σ\_direct | 0.80 | cosine | direct lane |
| `reviveExtraAccesses` |  | 2 | count | bonus when a dormant node is used |

## 5. Architecture

&#91;embedded content: architecture · 3 clients, 1 service, 5 tables, existing LiteLLM\]

One Node.js process serves every interface and runs the background work; the only math lives in `packages/activation`, which the browser UI imports too.

| Component | Responsibility | Sync with the client? |
| --- | --- | --- |
| Interfaces | MCP over Streamable HTTP, hook routes, UI routes, static UI | Yes for recall and prefetch; no for everything else |
| Recall pipeline | Seed cues, load neighborhood, spread, gate, lanes, trace (section 10.5) | Yes |
| Ingest worker | Claim queue rows, redact, extract, resolve, link, embed, supersede (section 11) | No |
| Reinforcement buffer | Collect uses in memory, flush in batches (section 10.6) | No |
| `packages/activation` | Base level, edge strength, spread, scoring (sections 4, 10) | Pure functions |
| Postgres + pgvector | All state, the queue, and vector search | n/a |
| LiteLLM (existing) | Embeddings, extraction, contradiction judgments on local models; Langfuse traces | Embedding is on the recall path; the rest is background |

Data flow in one turn: the client's lifecycle hook asks for prefetch, the pipeline embeds the prompt and returns context in well under a second, the model answers, then the hook posts the turn and returns at once. The worker turns that turn into nodes and edges a few seconds later, and detects which recalled memories the answer actually used.

## 6. Data model

Six tables carry phase 1; two more and RLS policies arrive in phase 2. Every table has `tenant_id` from the first migration, defaulting to `'local'`, so phase 2 adds policies without a data migration.

**Decisions**

- Edges are stored directed (`src`, `dst`) for provenance but traversed in both directions by spread.
- Nothing is ever hard-deleted by the service. Superseded or forgotten rows get `invalid_at`.
- `recent_access` holds at most `M` timestamps, newest first. `access_count` holds the full count.
- Embedding dimension is fixed per deployment by `EMBED_DIM` at the first migration (initial 1024). Changing models means a new column and a re-embed job, not an in-place change.
- Migrations are plain numbered SQL files in `db/migrations`, applied in order by a small runner that records each file in `schema_migrations`.

### 6.1 Phase 1 DDL

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE node_kind AS ENUM ('entity', 'fact', 'episode');

CREATE TABLE nodes (
  id             bigserial PRIMARY KEY,
  tenant_id      text        NOT NULL DEFAULT 'local',
  kind           node_kind   NOT NULL,
  label          text        NOT NULL,              -- short display name
  content        text,                              -- fact statement or episode summary
  label_norm     text        NOT NULL,              -- lower(trim(label)); entity key
  aliases        text[]      NOT NULL DEFAULT '{}',
  embedding      vector(1024),                      -- null until the worker embeds it
  occurred_at    timestamptz,                       -- episodes: when it happened
  created_at     timestamptz NOT NULL DEFAULT now(),
  access_count   integer     NOT NULL DEFAULT 1 CHECK (access_count >= 1),
  recent_access  timestamptz[] NOT NULL DEFAULT ARRAY[now()],  -- newest first, max M
  sources        text[]      NOT NULL DEFAULT '{}', -- claude-code | hermes | omp | manual
  invalid_at     timestamptz,                       -- superseded or forgotten
  superseded_by  bigint REFERENCES nodes(id),
  metadata       jsonb       NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX nodes_entity_key ON nodes (tenant_id, label_norm)
  WHERE kind = 'entity' AND invalid_at IS NULL;
CREATE INDEX nodes_live ON nodes (tenant_id, kind) WHERE invalid_at IS NULL;
CREATE INDEX nodes_embedding ON nodes USING hnsw (embedding vector_cosine_ops);

CREATE TABLE edges (
  id               bigserial PRIMARY KEY,
  tenant_id        text   NOT NULL DEFAULT 'local',
  src              bigint NOT NULL REFERENCES nodes(id),
  dst              bigint NOT NULL REFERENCES nodes(id),
  predicate        text   NOT NULL,                 -- 'with', 'about', 'ate', 'is'...
  half_life_class  text   NOT NULL DEFAULT 'default'
                   CHECK (half_life_class IN ('identity', 'default', 'incidental')),
  strength         double precision NOT NULL DEFAULT 1.0
                   CHECK (strength >= 0.001 AND strength <= 1.0),
  last_used_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  valid_from       timestamptz NOT NULL DEFAULT now(),
  invalid_at       timestamptz,
  source           text,
  CHECK (src <> dst)
);
CREATE UNIQUE INDEX edges_key ON edges (tenant_id, src, dst, predicate)
  WHERE invalid_at IS NULL;
CREATE INDEX edges_src ON edges (src) WHERE invalid_at IS NULL;
CREATE INDEX edges_dst ON edges (dst) WHERE invalid_at IS NULL;

CREATE TABLE ingest_queue (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL DEFAULT 'local',
  kind         text NOT NULL CHECK (kind IN ('remember', 'transcript')),
  client       text NOT NULL,
  session_id   text,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts     integer NOT NULL DEFAULT 0,
  run_after    timestamptz NOT NULL DEFAULT now(),   -- backoff: not claimed before this
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
CREATE INDEX ingest_queue_pending ON ingest_queue (created_at) WHERE status = 'pending';

CREATE TABLE sessions (
  tenant_id   text NOT NULL DEFAULT 'local',
  id          text NOT NULL,                        -- the client's session id
  client      text NOT NULL,
  title       text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE recall_trace (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL DEFAULT 'local',
  session_id   text,
  client       text NOT NULL,
  at           timestamptz NOT NULL DEFAULT now(),
  query        text,
  cue_ids      bigint[] NOT NULL,
  cue_weights  double precision[] NOT NULL,
  hops         jsonb NOT NULL,   -- [{hop, from, to, edge, amount}]
  recalled     jsonb NOT NULL,   -- [{id, lane, A, B, S}] lane: associative | exposure | direct
  used_ids     bigint[] NOT NULL DEFAULT '{}',
  params       jsonb NOT NULL,   -- config snapshot used for this recall
  duration_ms  integer NOT NULL
);
CREATE INDEX recall_trace_session ON recall_trace (tenant_id, session_id, at);

CREATE TABLE schema_migrations (
  filename    text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
```

### 6.2 Phase 2 additions

```sql
CREATE TABLE tenants (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  params         jsonb NOT NULL DEFAULT '{}',  -- per-tenant overrides of section 4.5
  password_hash  text NOT NULL,                -- UI login, argon2id
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_tokens (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants(id),
  token_hash   text NOT NULL UNIQUE,         -- sha256 of the token; plaintext never stored
  label        text NOT NULL,                -- e.g. 'hermes on gpu box'
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);

-- repeat for nodes, edges, ingest_queue, sessions, recall_trace
ALTER TABLE nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE nodes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nodes
  USING (tenant_id = current_setting('app.tenant_id'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id'));
```

The service runs every request in a transaction that starts with `SELECT set_config('app.tenant_id', $1, true)`, and connects as a role that does not own the tables. `FORCE ROW LEVEL SECURITY` makes the policy apply to the owner too, as a second guard.

## 7. Functional requirements

Each row is one ticket-sized requirement. Phase P1 is the prototype, P2 multi-tenancy, P3 the Rust extension. Acceptance criteria are written to be checked by an automated test where possible.

### 7.1 Ingest

| ID | Requirement | Phase | Acceptance criteria |
| --- | --- | --- | --- |
| FR-01 | `remember` enqueues raw input and returns at once | P1 | Returns `{queued_id}`; one `ingest_queue` row with status `pending`; no embedding or LLM call in the request path; p95 under 30 ms |
| FR-02 | `POST /api/ingest/transcript` accepts a batch of turns and enqueues them | P1 | Returns 202 with `{queued_id}`; body validated with the schema in section 9 |
| FR-03 | Worker claims queue items with `FOR UPDATE SKIP LOCKED` | P1 | Two workers never process the same item; `WORKER_CONCURRENCY` honored; failures retried with exponential backoff up to 5 attempts, then status `failed` with `last_error` |
| FR-04 | Worker extracts entities, facts, episodes and edges through LiteLLM with a JSON schema | P1 | Output validated against the extraction schema in section 11; invalid output retried once with the validation error in the prompt, then item `failed` |
| FR-05 | `remember` accepts optional client-supplied entities, facts and edges | P1 | When supplied and valid, the LLM extraction step is skipped for that item |
| FR-06 | Entity resolution merges mentions into existing entities | P1 | Match on `label_norm` or `aliases` first; else embedding similarity at least `entityMergeSim` (initial 0.92) merges and adds an alias; else a new node |
| FR-07 | A mention at ingest counts as an access of the mentioned node | P1 | Matched node gets one access at the queue item's `created_at`; `recent_access` trimmed to `M` |
| FR-08 | New nodes are embedded from `label` plus `content` | P1 | `embedding` set within one worker cycle; nodes without embeddings are skipped by vector search but still traversed by spread |
| FR-09 | A new fact that contradicts an existing fact supersedes it | P1 | Candidate facts share a subject entity and have similarity at least 0.85; LLM judges contradiction; old fact and its edges get `invalid_at`, `superseded_by` set; old fact still visible in the UI history |
| FR-10 | Transcript ingest is idempotent | P1 | Re-sending the same `(client, session_id, turn_index)` creates no new rows |

### 7.2 Recall

| ID | Requirement | Phase | Acceptance criteria |
| --- | --- | --- | --- |
| FR-11 | `recall` embeds the query, seeds cues by vector search, spreads, applies gates, and returns memories | P1 | Algorithm matches section 10; response matches section 8 |
| FR-12 | `recall` accepts explicit cue ids or labels | P1 | Explicit cues get `W = 1.0` and are merged with vector cues |
| FR-13 | Exposure lane returns all valid neighbors of each recalled episode | P1 | Dormant neighbors appear with `lane: "exposure"` |
| FR-14 | Direct lane returns the best matching fact regardless of activation | P1 | Returned only when similarity is at least `directMinSim`; marked `lane: "direct"` |
| FR-15 | Every recall writes one `recall_trace` row | P1 | Row written after the response is sent; a trace write failure never fails the recall |
| FR-16 | Recall never reinforces | P1 | Node `access_count` and edge `strength` unchanged after any number of recalls |
| FR-17 | `POST /api/recall/prefetch` returns a ready-to-inject context block | P1 | Result cached per `(client, session_id)` for `PREFETCH_TTL_SECONDS` (initial 600); a cache hit returns without embedding |
| FR-18 | Recall output has a compact text form and a structured form | P1 | Text form is at most `CONTEXT_MAX_CHARS` (initial 4000), one memory per line, ids included |

### 7.3 Use and reinforcement

| ID | Requirement | Phase | Acceptance criteria |
| --- | --- | --- | --- |
| FR-19 | `use` buffers ids in memory and flushes in batches | P1 | Flush every `USE_FLUSH_MS` (initial 5000) or 200 ids, whichever first; flush on shutdown; duplicate `(trace_id, node_id)` within a flush counted once |
| FR-20 | Using a node records an access | P1 | Appends now to `recent_access`, trims to `M`, increments `access_count`; a node that was dormant gets `reviveExtraAccesses` more |
| FR-21 | Using a node reinforces the edges on its path in that trace | P1 | Edges in the trace's `hops` that lead from a cue to the used node get the gain update in section 4.2 |
| FR-22 | `get_memory` by id counts as a use | P1 | Same effects as FR-20, without edge reinforcement |
| FR-23 | Implicit use is detected from ingested transcripts | P1 | When a transcript arrives, any node recalled in that session whose label appears (case-insensitive, word boundary) in an assistant message after the recall is marked used |
| FR-24 | `forget` invalidates a node and its edges | P1 | Excluded from every lane; `POST /api/nodes/:id/restore` clears `invalid_at` |

### 7.4 Sessions and operations

| ID | Requirement | Phase | Acceptance criteria |
| --- | --- | --- | --- |
| FR-25 | Sessions are created on first sight of a `session_id` | P1 | `sessions` row upserted; `title` = first 80 characters of the first prompt or query |
| FR-26 | `GET /healthz` reports service, database and LiteLLM status | P1 | 200 when all reachable, 503 otherwise, JSON body names the failing part |
| FR-27 | Parameters load from `config/params.json` with env overrides | P1 | Unknown keys rejected at startup; current params exposed at `GET /api/params` |
| FR-28 | Structured JSON logs for every request and worker job | P1 | Includes tenant, client, session, duration, outcome |
| FR-29 | Export a tenant to JSON | P2 | `GET /api/export` streams nodes, edges and sessions; import restores into an empty tenant |

### 7.5 Brain UI

| ID | Requirement | Phase | Acceptance criteria |
| --- | --- | --- | --- |
| FR-30 | Password login with a signed httpOnly cookie | P1 | Password from `UI_PASSWORD`; cookie `SameSite=Strict`, 30-day expiry; all `/api/*` UI routes reject requests without it |
| FR-31 | 3D brain graph view | P1 | Section 13.2 layout and encoding; rotate, zoom, pan |
| FR-32 | Node detail card | P1 | Opens on click; fields in section 13.3; clicking a connection selects that node |
| FR-33 | Session playback | P1 | Session list, play, pause, scrub; animation phases in section 13.4 |
| FR-34 | Decay time-lapse | P1 | Slider moves `now` from 0 to +365 days; node brightness recomputed from timestamps; no extra queries per slider step |
| FR-35 | Spread from here | P1 | Runs a recall with the node as the only explicit cue, marked `client: "manual"`, and plays it |
| FR-36 | Search and fly to node | P1 | Type-ahead over labels and aliases; selecting a result centers the camera on it |
| FR-37 | Show forgotten and superseded nodes on demand | P1 | Toggle; such nodes drawn hollow; card offers Restore |
| FR-38 | Filter by source client | P2 | Toggle per client; hidden nodes keep their positions |

### 7.6 Multi-tenancy

| ID | Requirement | Phase | Acceptance criteria |
| --- | --- | --- | --- |
| FR-40 | CLI to create tenants and tokens | P2 | `recall tenant create <id>`, `recall token create <tenant> <label>` prints the token once; `recall token revoke <id>` |
| FR-41 | Bearer token auth on MCP and HTTP routes | P2 | Token hashed with sha256 and looked up; tenant set with `set_config` per transaction; revoked or unknown token gets 401 |
| FR-42 | Row-level security isolates tenants | P2 | A test using tenant A's token cannot read, count or update any tenant B row, through any route |
| FR-43 | Per-tenant parameter overrides | P2 | `tenants.params` merged over defaults; recall uses the merged set and records it in the trace |
| FR-44 | UI login per tenant | P2 | Tenant id plus password checked against `password_hash` (argon2id) |

### 7.7 Rust extension

| ID | Requirement | Phase | Acceptance criteria |
| --- | --- | --- | --- |
| FR-50 | pgrx extension implements base level, edge decay and spread | P3 | SQL functions in section 10.7; installed with `CREATE EXTENSION recall_activation` |
| FR-51 | TypeScript and Rust produce the same results | P3 | Replay suite runs against both; every A, B, S and w matches within 1e-9; same recalled ids in the same order |
| FR-52 | Backend switch | P3 | `ACTIVATION_BACKEND=ts` or `pg`; no other code path changes |

## 8. MCP tool contracts

The MCP server exposes five tools over Streamable HTTP at `/mcp`. The `use` operation from section 4 is exposed as `mark_used`, a name small local models are less likely to misread. Tool descriptions below are the exact strings to ship; they are written for models, short and imperative.

All inputs are validated with zod. Every tool accepts optional `session_id` and `client`; when the transport carries a client name, that wins over the argument.

### 8.1 `remember`

Description: "Save something worth remembering about the user or their work. Returns immediately; processing happens in the background."

```ts
type RememberInput = {
  text: string;                 // 1..20000 chars; what happened or what is true
  occurred_at?: string;         // ISO 8601; defaults to now
  session_id?: string;
  client?: 'claude-code' | 'hermes' | 'omp' | 'manual';
  structured?: {                // optional; skips LLM extraction (FR-05)
    entities: { label: string; aliases?: string[] }[];
    facts: { subject: string; statement: string; half_life_class?: HalfLifeClass }[];
    episode?: { label: string; summary: string };
    edges: { from: string; to: string; predicate: string; half_life_class?: HalfLifeClass }[];
  };
};
type RememberOutput = { queued_id: number };
```

Side effects: one `ingest_queue` row. Nothing else in the request path.

### 8.2 `recall`

Description: "Recall memories related to the current conversation. Pass the user's message or a short description of what you need. Call mark\_used with the ids you actually rely on."

```ts
type RecallInput = {
  query: string;                // 1..4000 chars
  cues?: string[];              // node ids as strings, or labels
  limit?: number;               // 1..25, default resultLimit
  session_id?: string;
  client?: string;
};
type RecalledMemory = {
  id: number;
  kind: 'entity' | 'fact' | 'episode';
  label: string;
  content: string | null;
  lane: 'associative' | 'exposure' | 'direct';
  activation: number | null;    // A; null for exposure and direct
  base_level: number;           // B
  spread: number | null;        // S
  occurred_at: string | null;
  via: number | null;           // for exposure: the episode id that exposed it
};
type RecallOutput = {
  trace_id: number;
  memories: RecalledMemory[];   // associative ranked by A, then exposure, then direct
  text: string;                 // compact form for the model, FR-18
};
```

Text form, one line per memory:

```text
[#4812 episode] Thursday dinner (2026-11-12): cooked dinner, Todd called mid-meal
  [#3301 entity, exposed] Spaghetti
[#2290 fact] Todd's trip is in May
```

Side effects: one `recall_trace` row, written after the response. No reinforcement.

### 8.3 `mark_used`

Description: "Tell memory which recalled ids you actually used in your answer. This strengthens them."

```ts
type MarkUsedInput = { trace_id?: number; ids: number[] };  // 1..50 ids
type MarkUsedOutput = { accepted: number };
```

Side effects: ids added to the reinforcement buffer (FR-19). When `trace_id` is given, edge reinforcement follows that trace's paths (FR-21) and `recall_trace.used_ids` is updated.

### 8.4 `get_memory`

Description: "Get one memory by id, with its connections."

```ts
type GetMemoryInput = { id: number };
type GetMemoryOutput = RecalledMemory & {
  connections: { id: number; label: string; kind: string; predicate: string; strength: number; dormant: boolean }[];
};
```

Side effects: counts as a use of that node (FR-22).

### 8.5 `forget`

Description: "Forget a memory the user asked you to forget. Use only when the user asks."

```ts
type ForgetInput = { id: number; reason?: string };
type ForgetOutput = { forgotten: true };
```

Side effects: `invalid_at` on the node and its edges (FR-24). Reversible from the UI.

### 8.6 Errors

Tool errors return MCP error results with a short message a model can act on: `"No memory with id 991"`, `"text is empty"`. Internal errors are logged with a request id and return `"Memory is unavailable right now"` so a client session continues without memory.

## 9. HTTP API

The same process serves hook routes for clients and UI routes for the browser. Hook routes are what keep memory off the hot path; client hooks call them in the background and never block on the result except for prefetch.

**Auth.** In P1, hook routes require `Authorization: Bearer $RECALL_TOKEN` when that env var is set, and are open on the LAN when it is not. UI routes require the session cookie from `/auth/login`. In P2 both use per-tenant tokens and logins (FR-41, FR-44).

### 9.1 Routes

| Method | Path | Caller | Phase | Purpose |
| --- | --- | --- | --- | --- |
| POST | `/mcp` | MCP clients | P1 | Streamable HTTP MCP endpoint (section 8) |
| POST | `/api/recall/prefetch` | hooks | P1 | Recall for session start or a new prompt; returns injectable text (FR-17) |
| POST | `/api/ingest/transcript` | hooks | P1 | Enqueue turns (FR-02, FR-10) |
| POST | `/api/mark-used` | hooks | P1 | Same as the `mark_used` tool |
| POST | `/api/sessions/end` | hooks | P1 | Set `ended_at`, flush the reinforcement buffer |
| POST | `/auth/login` | UI | P1 | Body `{password}`; sets cookie |
| POST | `/auth/logout` | UI | P1 | Clears cookie |
| GET | `/api/graph` | UI | P1 | Whole graph for rendering; `?include_invalid=true` adds forgotten and superseded rows |
| GET | `/api/nodes/:id` | UI | P1 | Card data; does not count as a use |
| GET | `/api/search?q=` | UI | P1 | Top 10 nodes by label and alias prefix match |
| GET | `/api/sessions` | UI | P1 | Sessions newest first, with trace counts |
| GET | `/api/sessions/:id/traces` | UI | P1 | Traces of one session in time order, with `hops` |
| POST | `/api/recall` | UI | P1 | Spread from here (FR-35); body `{cues: number[]}`, client `manual` |
| POST | `/api/nodes/:id/restore` | UI | P1 | Undo forget (FR-24) |
| GET | `/api/params` | UI | P1 | Effective parameters (FR-27) |
| GET | `/healthz` | ops | P1 | FR-26 |
| GET | `/api/events` | UI | P2 | Server-sent events: new traces and node changes for a live view |
| GET | `/api/export` | ops | P2 | FR-29 |

Also in P1: four `POST /hooks/claude-code/*` routes that accept Claude Code's native hook payloads (section 12.1).

### 9.2 Hook request bodies

```ts
type PrefetchRequest = {
  client: 'claude-code' | 'hermes' | 'omp';
  session_id: string;
  prompt: string;           // first user prompt, or the latest one
  cwd?: string;             // project directory; its basename is added as a cue label
};
type PrefetchResponse = { trace_id: number; text: string };  // text may be empty

type TranscriptRequest = {
  client: 'claude-code' | 'hermes' | 'omp';
  session_id: string;
  turns: {
    index: number;          // position in the session, for idempotency
    role: 'user' | 'assistant';
    content: string;        // plain text; tool calls and results stripped by the hook
    at: string;             // ISO 8601
  }[];                      // 1..200 turns
};
```

### 9.3 Graph payload

The UI receives raw access history, not computed activation, and computes B, P and w\_eff itself with the shared `packages/activation` module. This is what makes the time-lapse free: moving the slider only changes `now`.

```ts
type GraphResponse = {
  now: string;
  params: Params;
  nodes: {
    id: number; kind: 'entity' | 'fact' | 'episode'; label: string;
    created_at: string; access_count: number; recent_access: string[];
    sources: string[]; invalid: boolean;
  }[];
  edges: {
    id: number; src: number; dst: number; predicate: string;
    strength: number; last_used_at: string; half_life_class: HalfLifeClass; invalid: boolean;
  }[];
};
```

P1 sends the whole graph in one response. If a store grows past 20,000 nodes, paging is an open question (section 18).

## 10. Algorithms

`packages/activation` is a pure TypeScript module: no imports from Node, Postgres or the network, no `Date.now()`, no randomness. The service and the UI both import it. Times are passed as epoch milliseconds. Ties are always broken by ascending node id so output order is deterministic.

### 10.1 Base level and recall probability

```ts
const DAY = 86_400_000;

export function baseLevel(
  n: { accessCount: number; recentAccess: number[]; createdAt: number },  // recentAccess newest first
  now: number, p: Params,
): number {
  const ages = n.recentAccess.map(t => Math.max((now - t) / DAY, p.minAgeDays));
  let sum = 0;
  for (const a of ages) sum += Math.pow(a, -p.decay);
  const m = ages.length, rest = n.accessCount - m;
  if (rest > 0 && m > 0) {
    const L = Math.max((now - n.createdAt) / DAY, p.minAgeDays);
    const tm = ages[m - 1];
    if (L - tm >= p.minAgeDays) {
      const k = 1 - p.decay;
      sum += (rest * (Math.pow(L, k) - Math.pow(tm, k))) / (k * (L - tm));
    }
  }
  return Math.log(sum);
}

export const recallProbability = (B: number, p: Params) =>
  1 / (1 + Math.exp(-(B - p.tau) / p.noiseScale));

export const isDormantNode = (B: number, p: Params) => recallProbability(B, p) < p.dormantP;
```

### 10.2 Edge strength and reinforcement

```ts
export function edgeStrength(
  e: { strength: number; lastUsedAt: number; halfLifeClass: HalfLifeClass }, now: number, p: Params,
): number {
  const h = p.halfLifeDays[e.halfLifeClass];
  const decayed = e.strength * Math.pow(0.5, Math.max(0, now - e.lastUsedAt) / DAY / h);
  return Math.max(p.edgeFloor, decayed);
}

export function reinforceEdge(e: EdgeState, now: number, p: Params): EdgeState {
  const w = edgeStrength(e, now, p);
  return { ...e, strength: Math.min(1, w + p.edgeGain * (1 - w)), lastUsedAt: now };
}

export function recordAccess(n: NodeState, now: number, p: Params, wasDormant: boolean): NodeState {
  const extra = wasDormant ? p.reviveExtraAccesses : 0;
  const stamps = Array(1 + extra).fill(now);
  return {
    ...n,
    accessCount: n.accessCount + 1 + extra,
    recentAccess: [...stamps, ...n.recentAccess].slice(0, p.recentAccesses),
  };
}
```

### 10.3 Spreading activation

The neighborhood is an adjacency map loaded by the service (10.5). Edges are undirected for spread. Fan is the count of valid edges on the node.

```ts
export type Flow = { hop: number; from: number; to: number; edge: number; amount: number };

export function spread(
  g: { adj: Map<number, { to: number; edge: EdgeState & { id: number } }[]> },
  cues: { id: number; weight: number }[],
  now: number, p: Params,
): { activation: Map<number, number>; flows: Flow[] } {
  const cueIds = new Set(cues.map(c => c.id));
  const activation = new Map<number, number>();
  const flows: Flow[] = [];
  let frontier = new Map(cues.map(c => [c.id, c.weight]));
  let expanded = 0;
  for (let hop = 1; hop <= p.hops && frontier.size > 0; hop++) {
    const next = new Map<number, number>();
    const sources = [...frontier.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    for (const [u, a] of sources) {
      if (expanded++ >= p.maxExpanded) break;
      const list = g.adj.get(u) ?? [];
      const fan = list.length;
      for (const { to, edge } of list) {
        if (cueIds.has(to)) continue;
        const amount = (a * edgeStrength(edge, now, p) * p.damping) / fan;
        if (amount < p.pruneEpsilon) continue;
        next.set(to, (next.get(to) ?? 0) + amount);
        flows.push({ hop, from: u, to, edge: edge.id, amount });
      }
    }
    for (const [v, a] of next) activation.set(v, (activation.get(v) ?? 0) + a);
    frontier = next;
  }
  return { activation, flows };
}
```

### 10.4 Scoring and lanes

```ts
export function score(
  nodes: Map<number, NodeState & { kind: Kind }>, activation: Map<number, number>, now: number, p: Params,
): { id: number; A: number; B: number; S: number }[] {
  const out = [];
  for (const [id, S] of activation) {
    const n = nodes.get(id);
    if (!n || S < p.minSpread) continue;
    const B = baseLevel(n, now, p);
    const A = B + p.spreadWeight * S;
    if (A >= p.recallThreshold) out.push({ id, A, B, S });
  }
  return out.sort((x, y) => y.A - x.A || x.id - y.id).slice(0, p.resultLimit);
}

export function pathEdges(flows: Flow[], target: number): Set<number> {
  // walk flows backwards from the target to the cues; collect edge ids
  const edges = new Set<number>();
  let layer = new Set([target]);
  for (let hop = Math.max(0, ...flows.map(f => f.hop)); hop >= 1; hop--) {
    const prev = new Set<number>();
    for (const f of flows) if (f.hop === hop && layer.has(f.to)) { edges.add(f.edge); prev.add(f.from); }
    for (const x of prev) layer.add(x);
  }
  return edges;
}
```

### 10.5 Recall pipeline (service)

1. Upsert the session (FR-25).
2. Embed the query through LiteLLM. On embedding failure, continue with explicit cues only.
3. Seed: `SELECT id, 1 - (embedding <=> $q) AS sim FROM nodes WHERE invalid_at IS NULL AND embedding IS NOT NULL ORDER BY embedding <=> $q LIMIT seedK`. Keep rows with `sim >= seedMinSim`; weight = sim. Merge explicit cues with weight 1.0; resolve label cues by `label_norm` or alias.
4. Load the neighborhood hop by hop, `hops` queries at most: `SELECT * FROM edges WHERE invalid_at IS NULL AND (src = ANY($ids) OR dst = ANY($ids))`, then fetch the nodes those edges reach. Stop at `maxExpanded` nodes.
5. Run `spread`, then `score` for the associative lane.
6. Exposure lane: for each recalled `episode`, add every valid neighbor not already in the result, with `via` = the episode id.
7. Direct lane: `SELECT ... FROM nodes WHERE kind = 'fact' AND invalid_at IS NULL ORDER BY embedding <=> $q LIMIT 1`; include when `sim >= directMinSim` and not already present.
8. Build the response and the text form (FR-18) and send it.
9. After sending, insert the `recall_trace` row with cues, flows (pruned to amounts at least 0.004 to keep rows small), recalled rows, params and duration.

### 10.6 Reinforcement flush (service)

Every `USE_FLUSH_MS`, the buffer is swapped for an empty one and applied in one transaction:

1. Load the used nodes and compute `wasDormant` from their current B.
2. Apply `recordAccess` and write `access_count` and `recent_access`.
3. For each `(trace_id, node_id)` pair, load the trace's flows, compute `pathEdges`, apply `reinforceEdge` once per edge per flush, and write `strength` and `last_used_at`.
4. Append the node ids to `recall_trace.used_ids`.

### 10.7 Phase 3 SQL surface

The Rust extension implements the same functions as SQL, so the service can swap backends (FR-52):

```sql
recall_base_level(access_count int, recent_access timestamptz[], created_at timestamptz,
                  now timestamptz, params jsonb) RETURNS double precision
recall_edge_strength(strength double precision, last_used_at timestamptz,
                     half_life_class text, now timestamptz, params jsonb) RETURNS double precision
recall_spread(tenant text, cue_ids bigint[], cue_weights double precision[],
              now timestamptz, params jsonb)
  RETURNS TABLE (hop int, src bigint, dst bigint, edge bigint, amount double precision)
```

`recall_spread` reads `edges` itself, which removes the per-hop round trips of step 4. Its flows must equal the TypeScript `spread` output for the same graph.

## 11. Ingest pipeline

Ingest turns raw text into nodes and edges in the background. A request only inserts a queue row; the worker does redaction, extraction, resolution, embedding, contradiction checks and writes, in that order, inside one transaction per item.

### 11.1 Worker loop

```sql
-- claim one item; run in a loop per worker slot
UPDATE ingest_queue SET status = 'processing', started_at = now(), attempts = attempts + 1
WHERE id = (
  SELECT id FROM ingest_queue
  WHERE status = 'pending' AND run_after <= now()
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

- Idle workers poll every 1 s. `LISTEN/NOTIFY` on insert is an allowed optimization, not a requirement.
- On failure: if `attempts < 5`, set `status = 'pending'`, `run_after = now() + 2^attempts seconds`, `last_error`; else `status = 'failed'`.
- On startup and every 5 minutes, items stuck in `processing` for more than 10 minutes go back to `pending`.
- Graceful shutdown: stop claiming, finish in-flight items, flush the reinforcement buffer, then exit. Queue rows with status `done` older than 30 days are deleted nightly.

### 11.2 Steps per item

1. **Redact.** Remove strings that look like secrets before any model sees them: private keys, bearer tokens, `sk-` style API keys, AWS access keys, passwords in URLs. Replace with `[redacted]`.
2. **Window.** Transcripts are split into windows of at most `EXTRACT_WINDOW_CHARS` (initial 6000) on turn boundaries. Each window is extracted separately; results are merged by entity label.
3. **Extract.** Call the extraction model (11.3). Skip when `structured` was supplied (FR-05).
4. **Resolve entities** (FR-06). Resolution order: exact `label_norm`, alias match, then embedding similarity at least `entityMergeSim` among entities. A match records an access (FR-07).
5. **Create** new episodes, entities and facts. Episodes get `occurred_at` from the extraction, else the earliest turn time in the window.
6. **Link.** Create edges from the extraction. Also link every entity and fact mentioned in an episode to that episode with predicate `mentioned_in`, class `incidental`. An existing valid edge with the same `(src, dst, predicate)` is reinforced instead of duplicated.
7. **Embed** every new or changed node in one batch call (FR-08).
8. **Contradiction check** (FR-09) for each new fact (11.4).
9. **Implicit use** (FR-23) for transcripts: match labels of nodes recalled earlier in the session against assistant turns.
10. Mark the item `done`.

### 11.3 Extraction contract

Model alias `EXTRACT_MODEL` through LiteLLM, temperature 0. Use a JSON schema `response_format` when the backing model supports it; otherwise JSON mode. Always validate with zod.

```ts
type Extraction = {
  episodes: { key: string; label: string; summary: string; occurred_at?: string }[];
  entities: { key: string; label: string; aliases?: string[] }[];
  facts: { key: string; subject_key: string; statement: string; half_life_class: HalfLifeClass }[];
  edges: { from_key: string; to_key: string; predicate: string; half_life_class: HalfLifeClass }[];
};
// keys are local to one extraction; edges may reference episodes, entities or facts by key
```

System prompt:

```text
You extract long-term memories about one user from a conversation with an AI assistant.
Return JSON matching the schema. Use only what the text states. Do not guess.

Keep: people, places, projects, tools and things the user cares about; stated facts and
preferences; events with a time (calls, meals, trips, debugging sessions, decisions).
Skip: greetings, the assistant's own suggestions unless the user adopted them, code,
file contents, command output, anything marked [redacted].

episodes: one per distinct event. label is 2 to 5 words. summary is one sentence.
entities: canonical names; put nicknames and other spellings in aliases.
facts: one statement each, written as a short sentence about the subject.
edges: predicate is one or two lowercase words: with, about, at, ate, uses, works_on, is.
half_life_class: identity for names, relationships and stated preferences;
incidental for passing mentions; default otherwise.
If nothing is worth keeping, return empty arrays.
```

### 11.4 Contradiction check

For a new fact F with subject S: candidates are valid facts linked to S whose embedding similarity to F is at least 0.85. For each candidate, ask the extraction model: "Do these two statements about the same subject contradict each other, so that the new one replaces the old one? Answer yes or no." On yes, set the old fact's `invalid_at = now()` and `superseded_by = F.id`, and set `invalid_at` on its edges. Never delete.

### 11.5 Ingest from `remember`

A `remember` item is a single window. When the text reads as a standalone fact ("my favorite color is blue"), extraction will usually produce one fact and no episode; that is valid. An item that produces nothing is `done` with metadata `{empty: true}`.

## 12. Client integrations

Each client gets the MCP tools for explicit memory work, plus a lifecycle integration that prefetches recall and ships turns without the model doing anything. The lifecycle side is what makes memory work with small local models.

| Moment | Claude Code | Hermes | omp |
| --- | --- | --- | --- |
| Session start | `SessionStart` http hook | `MemoryProvider.initialize` | `session_start` handler |
| Before a turn: recall | `UserPromptSubmit` http hook returns `additionalContext` | `MemoryProvider.prefetch(query, session_id=...)` | `before_agent_start` handler returns `{message}` |
| After a turn: ingest | `Stop` http hook with `last_assistant_message` | `MemoryProvider.sync_turn(user, assistant, ...)`, non-blocking | `turn_end` or `agent_end` handler |
| Warm the next turn | not needed | `MemoryProvider.queue_prefetch` | not needed |
| Session end | `SessionEnd` http hook | `MemoryProvider.on_session_end(messages)` | `session_shutdown` handler |
| Tools | MCP via `.mcp.json` | MCP via `~/.hermes/config.yaml` `mcp_servers` | MCP via discovered `.mcp.json` |

### 12.1 Claude Code

Claude Code supports `"type": "http"` hooks that POST the hook input JSON to a URL and read the same JSON output format from the response. Non-2xx responses and connection failures are non-blocking, so a down memory service never breaks a session. The service therefore exposes native Claude Code hook routes that accept Claude Code's own payloads; no shell script is needed.

| Route | Event | Behavior |
| --- | --- | --- |
| `POST /hooks/claude-code/session-start` | `SessionStart` | Upsert session; recall with the `cwd` basename as cue; respond with `hookSpecificOutput.additionalContext` |
| `POST /hooks/claude-code/user-prompt-submit` | `UserPromptSubmit` | Store the prompt as a pending user turn; run prefetch recall; respond with `additionalContext` |
| `POST /hooks/claude-code/stop` | `Stop` | Pair `last_assistant_message` with the stored prompt; enqueue both turns; respond `{}` at once |
| `POST /hooks/claude-code/session-end` | `SessionEnd` | Set `ended_at`, flush; respond `{}` at once |

`~/.claude/settings.json` (user scope, so every project gets memory):

```json
{
  "hooks": {
    "SessionStart": [{ "matcher": "startup", "hooks": [
      { "type": "http", "url": "http://recall.lan:7420/hooks/claude-code/session-start", "timeout": 5,
        "headers": { "Authorization": "Bearer $RECALL_TOKEN" }, "allowedEnvVars": ["RECALL_TOKEN"] } ] }],
    "UserPromptSubmit": [{ "hooks": [
      { "type": "http", "url": "http://recall.lan:7420/hooks/claude-code/user-prompt-submit", "timeout": 5,
        "headers": { "Authorization": "Bearer $RECALL_TOKEN" }, "allowedEnvVars": ["RECALL_TOKEN"] } ] }],
    "Stop": [{ "hooks": [
      { "type": "http", "url": "http://recall.lan:7420/hooks/claude-code/stop", "timeout": 5,
        "headers": { "Authorization": "Bearer $RECALL_TOKEN" }, "allowedEnvVars": ["RECALL_TOKEN"] } ] }],
    "SessionEnd": [{ "hooks": [
      { "type": "http", "url": "http://recall.lan:7420/hooks/claude-code/session-end", "timeout": 5,
        "headers": { "Authorization": "Bearer $RECALL_TOKEN" }, "allowedEnvVars": ["RECALL_TOKEN"] } ] }]
  }
}
```

Rules for these routes:

- Context text is written as plain factual statements ("Known from earlier sessions: ..."), not instructions; Claude Code docs warn that imperative wording can trigger prompt-injection defenses.
- Keep `additionalContext` under `CONTEXT_MAX_CHARS`; Claude Code moves values over 10,000 characters to a file.
- `SessionEnd` hooks share a short time budget, so that route must only enqueue.
- Use `last_assistant_message` from `Stop` rather than reading `transcript_path`; the docs note the transcript file can lag the turn, and the service may not run on the same machine.
- The `.mcp.json` entry for the tools: `{"mcpServers": {"recall": {"type": "http", "url": "http://recall.lan:7420/mcp"}}}`.

### 12.2 Hermes

Hermes has a native memory provider slot: one external provider is active at a time, selected by `memory.provider` in `~/.hermes/config.yaml`, with settings under `memory.<name>`. A provider is a Python class extending `MemoryProvider` from `agent/memory_provider.py`, registered with `ctx.register_memory_provider(...)` from a `register(ctx)` function. This is a better fit than observer hooks, which are read-only except `pre_llm_call`.

Deliverable: `integrations/hermes/recall/` with `__init__.py`, `plugin.yaml` and `README.md`, installed to `$HERMES_HOME/plugins/recall/`. It is a thin HTTP client to the service, standard library only (`urllib`), so it needs no extra packages.

| Method | Implementation |
| --- | --- |
| `name` | `"recall"` |
| `is_available()` | True when `RECALL_URL` is set; no network call, as the interface requires |
| `initialize(session_id, **kwargs)` | Store `session_id`; read `RECALL_URL`, `RECALL_TOKEN` |
| `prefetch(query, *, session_id="")` | Return the cached prefetch text for this session when fresh, else call `/api/recall/prefetch` with a 2 s timeout; on error return `""` |
| `queue_prefetch(query, *, session_id="")` | Background prefetch for the next turn into the local cache |
| `sync_turn(user, assistant, *, session_id="", messages=None)` | POST both turns to `/api/ingest/transcript` on a thread from `agent.memory_provider.spawn_context_thread`; must not block |
| `on_session_end(messages)` | POST `/api/sessions/end` |
| `system_prompt_block()` | One line: memory is available and recalled items carry ids for `mark_used` |
| `shutdown()` | Join in-flight threads with a short timeout |

`config.yaml`:

```yaml
memory:
  provider: recall
mcp_servers:
  recall:
    url: "http://recall.lan:7420/mcp"
    headers:
      Authorization: "Bearer ${RECALL_TOKEN}"
```

Hermes registers MCP tools with the prefix `mcp_<server>_<tool>`, so the tools appear as `mcp_recall_recall`, `mcp_recall_mark_used` and so on.

### 12.3 omp

omp loads TypeScript extensions that register handlers with `pi.on("<event>", async (event, ctx) => ...)`. `before_agent_start` receives the `prompt` and may return `{ message }`, which is added to the session. Deliverable: `integrations/omp/recall.ts`.

- `session_start`: upsert session.
- `before_agent_start`: call `/api/recall/prefetch` with the prompt, 2 s timeout; return `{ message }` with the context text when non-empty.
- `turn_end` or `agent_end`: POST the turn to `/api/ingest/transcript`, fire and forget. The exact payload fields of these events are defined in omp's `shared-events.ts` and must be read before implementing.
- `session_shutdown`: POST `/api/sessions/end`.
- MCP tools come from the same `.mcp.json` Claude Code uses; omp discovers it.

Reference while building: omp's own memory backends include a Hindsight provider exposing `retain`, `recall` and `reflect`, a useful comparison for tool shape.

## 13. Brain UI

The UI is the memory's debugger: it shows what is strong, what is fading, and exactly why a recall returned what it did. The [Recall Atlas mockup](https://claude.ai/artifact/BnVakaKVVzkiHE3Zd7c9Rf) is the visual reference; the build replaces its sample data with `/api/graph` and `/api/sessions`.

### 13.1 Stack

- React and Vite, built into `apps/ui/dist` and served as static files by the service.
- `react-force-graph-3d` (three.js) for the graph: `d3Force` for the custom brain-shape force, `nodeThreeObject` for node sprites, `emitParticle` for spread animation, `postProcessingComposer` for bloom. **Pin 1.29.2**: the npm `latest` tag is a stale stub package; the PRD's CDN-link pattern breaks against it.
- `packages/activation` imported directly for B, P and edge strength.
- No state library; React state and one context for the selected node and playback.

### 13.2 Graph view

- **Shape:** two hemisphere ellipsoids, a cerebellum and a stem drawn as a faint point cloud. A custom `d3Force` named `brain` replaces the default `center` force and pulls each node toward its target shell. Entities sit on the outer shell, facts at about 0.6 of the radius, episodes deep near the center (the hippocampus metaphor).
- **Clusters:** communities computed client-side (Louvain) choose a hemisphere and a region, so related nodes sit together. Positions are cached in `localStorage` per node id so the layout is stable between visits.
- **Node encoding:** color by kind (entity cyan, episode amber, fact violet); brightness and size from P; dormant nodes stay visible but faint.
- **Edge encoding:** opacity from edge strength; edges at the floor drawn dashed.
- **Recall highlight:** nodes over the threshold in the current trace glow with bloom and turn pink.
- **Labels:** shown for hovered, selected and currently active nodes, and for episodes when idle; hidden otherwise to keep the view readable.
- **Controls:** orbit drag to rotate, wheel or pinch to zoom, right-drag to pan, auto-rotate toggle, reset view, legend panel (collapsed on phones).

### 13.3 Node card

Opens on click; on phones it is a bottom sheet. Escape or the close button dismisses it; the camera eases to center the node.

- Kind chip and state chip (active, fading, dormant, forgotten, superseded).
- Label as heading; `content` as summary.
- Stats: base level B, recall probability P with a bar, uses, last used, first seen, sources.
- Connections sorted by strength: label, predicate, strength bar, `dormant 0.001` tag at the floor. Clicking one selects that node.
- For superseded facts: a "Replaced by" link to the newer fact.
- Actions: Spread from here (FR-35), Forget or Restore (FR-24).

### 13.4 Playback

A dock at the bottom holds a session picker, client tag, play and pause, a scrubber with elapsed time, and a one-line caption that explains each phase. A trace plays in these phases:

1. **Cues** light up one by one, 0.45 s apart. The caption lists them.
2. **Hops:** particles travel along each flow of hop 1, then hop 2, then hop 3, 1.6 s per hop, 1.1 s travel time. Particle size scales with the flow amount. Nodes brighten as activation arrives.
3. **Recall:** nodes that passed the gates flash and turn pink. The caption lists them with their A.
4. **Exposure:** dormant neighbors exposed by recalled episodes flash, and their dashed edges turn solid pink.
5. **Use:** for ids in `used_ids`, a pulse shows reinforcement and the caption shows B before and after.

A session with several traces plays them in order with a short gap. The scrubber position maps to time across the whole session.

### 13.5 Time-lapse

A slider in the header moves `now` from today to +365 days. Every node's B and P and every edge's strength are recomputed in the browser from the payload, with no request per step. Labels and the card update live. This is the direct view of forgetting.

### 13.6 Search

A search box with type-ahead over labels and aliases (`/api/search`). Choosing a result selects the node and flies the camera to it.

### 13.7 Design notes

- Single dark theme on purpose; glow needs a dark ground.
- Fonts: Space Grotesk for headings, Inter for body, JetBrains Mono for numbers.
- Respect `prefers-reduced-motion`: no auto-rotate, and playback steps between phases instead of animating particles.
- Works at phone width: the header wraps, the legend collapses, the card becomes a bottom sheet.

## 14. Non-functional requirements

Latency figures are targets for the homelab hardware, measured with the benchmark script in section 15.4 on a store of 10,000 nodes and 50,000 edges. They are acceptance thresholds, not guarantees about the hardware.

| ID | Area | Requirement | Measure |
| --- | --- | --- | --- |
| NFR-01 | Latency | Recall without the embedding call | p95 under 150 ms |
| NFR-02 | Latency | Recall including the embedding call | p95 under 400 ms |
| NFR-03 | Latency | `remember`, `mark_used`, transcript ingest and `Stop` / `SessionEnd` hook routes | p95 under 30 ms; no model call in the request path |
| NFR-04 | Latency | Prefetch and `UserPromptSubmit` routes stop work at an internal 2 s budget and return empty context | Verified by a test with an artificially slow embedding stub |
| NFR-05 | Resilience | Every client integration fails open | With the service stopped, a Claude Code, Hermes and omp session each complete a turn normally |
| NFR-06 | Durability | Queue items survive restarts; the reinforcement buffer flushes on SIGTERM | Kill and restart mid-ingest loses no queue item; a crash loses at most `USE_FLUSH_MS` of uses |
| NFR-07 | Determinism | `packages/activation` returns identical output for identical input | Property test with 1,000 random graphs, run twice, byte-identical JSON |
| NFR-08 | Scale | Store handles 100,000 nodes and 500,000 edges | NFR-01 holds at that size with `maxExpanded` unchanged |
| NFR-09 | Scale | UI renders 20,000 nodes interactively | Smooth rotation in Chrome on the homelab desktop; labels culled |
| NFR-10 | Security | Service binds to `BIND_ADDRESS` (LAN or Tailscale) only | Startup refuses `0.0.0.0` unless `ALLOW_ALL_INTERFACES=true` |
| NFR-11 | Security | Secrets are redacted before any model call and never logged | Test corpus of fake keys and tokens never appears in prompts or logs |
| NFR-12 | Privacy | Models are local | Startup refuses a LiteLLM base URL outside private address ranges unless `ALLOW_REMOTE_MODELS=true` |
| NFR-13 | Observability | JSON logs with request id, tenant, client, session, duration | One log line per request and per worker job |
| NFR-14 | Observability | Model calls traced through the existing LiteLLM to Langfuse setup | Extraction and embedding calls visible in Langfuse with the request id as metadata |
| NFR-15 | Operations | Nightly `pg_dump`, 14 copies kept | Restore drill documented in the README |
| NFR-16 | Quality | TypeScript `strict`; no `any` in `packages/activation`; ESLint clean | CI fails otherwise |
| NFR-17 | Quality | `packages/activation` test coverage | 100% of branches |
| NFR-18 | Accessibility | UI keyboard focus visible; honors `prefers-reduced-motion` | Manual checklist in the PR template |

## 15. Testing

The replay harness is the main tool of this project: it is how parameters get tuned, how regressions are caught, and later how the Rust port is proven equal. Build it before the MCP server.

### 15.1 Test layers

| Layer | Tool | Covers |
| --- | --- | --- |
| Unit | Vitest | `packages/activation`, every function, 100% branches (NFR-17) |
| Replay | Vitest runner over YAML scenarios | Recall behavior with an injected clock and a stub embedder, in memory, no database |
| Integration | Vitest against Postgres from the compose `test` profile | SQL, queue, worker, reinforcement flush, routes, MCP tools |
| Client smoke | Manual checklist in `docs/smoke.md` | One real session per client: prefetch appears, turn is ingested, recall works across clients |
| Benchmark | `pnpm bench` | NFR-01, NFR-02, NFR-08 |
| Conformance (P3) | Replay runner with `ACTIVATION_BACKEND=pg` | FR-51 |

### 15.2 Scenario format

Scenarios live in `scenarios/*.yaml`. Times are offsets in days from a fixed epoch. The stub embedder returns the similarities a scenario declares, so lanes can be tested without a model.

```yaml
name: convergent-cues
params: {}                      # overrides of section 4.5
nodes:
  - { key: todd, kind: entity, label: Todd, accesses: [-2, -2.1, -9, -30], created: -250 }
  - { key: italy, kind: entity, label: Italy, accesses: [-2, -30, -61], created: -120 }
  - { key: thursday, kind: entity, label: Thursday, accesses: [-1, -2, -9, -16, -23, -30], created: -365 }
  - { key: spaghetti, kind: entity, label: Spaghetti, accesses: [-40, -95], created: -300 }
  - { key: dinner, kind: episode, label: Thursday dinner, accesses: [-2], created: -2 }
  - { key: call, kind: episode, label: Call with Todd, accesses: [-2], created: -2 }
edges:
  - { from: dinner, to: thursday, predicate: happened_on, strength: 0.5, last_used: -2 }
  - { from: dinner, to: spaghetti, predicate: ate, strength: 0.001, last_used: -40 }
  - { from: dinner, to: call, predicate: during, strength: 0.6, last_used: -2 }
  - { from: call, to: todd, predicate: with, strength: 0.8, last_used: -2 }
  - { from: call, to: italy, predicate: about, strength: 0.7, last_used: -2 }
steps:
  - at: 0
    recall: { cues: [todd, italy, thursday] }
    expect:
      associative_includes: [call, dinner]
      exposure_includes: [spaghetti]
      associative_excludes: [spaghetti]
```

Supported step actions: `recall` (with `cues` or `query` plus `similar: {key: sim}`), `use: [keys]`, `remember` (structured only), `advance: days`. Supported expectations: `associative_includes`, `associative_excludes`, `associative_top: [keys]` (order), `exposure_includes`, `direct_is`, `none_of: [keys]`, `node: {key, dormant | active, B_gt, B_lt}`, `edge: {from, to, strength_gt, strength_lt}`. The runner writes each recall as a trace JSON file under `out/traces/` in the `recall_trace` shape, so the UI can play fixture traces with no database.

### 15.3 Required scenarios

The phase 1 exit gate is all of these passing with the default parameters. If a default value has to change to pass, change it in section 4.5 and record why in the PR.

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| SC-01 | Convergent cues (Todd, Italy, Thursday) | Call with Todd and Thursday dinner are in the associative lane; Spaghetti is in the exposure lane via Thursday dinner and not in the associative lane |
| SC-02 | Broad cue alone: Thursday, with 40 other episodes also linked to it | Thursday dinner stays under \`minSpread\` because of Thursday's fan, so Spaghetti is not returned in any lane |
| SC-03 | Dormant fact, specific question | "Favorite color is blue", last accessed 210 days ago, is returned in the direct lane when the query similarity is 0.9 |
| SC-04 | Dormant fact, broad question | The same fact is not returned when the query similarity is 0.5 |
| SC-05 | Decay of a single access | P is above 0.9 one day after one access and the node is dormant 90 days after |
| SC-06 | Frequency | At +60 days, a node with 10 accesses has higher B than a node with 1 access at the same last-access time |
| SC-07 | Fan effect | A target linked to a cue with 2 edges gets more spread than the same target linked by an equal-strength edge to a cue with 50 edges |
| SC-08 | Recall does not reinforce | After 20 recalls, every B and every edge strength is unchanged |
| SC-09 | Use reinforces node and path | After recall then `use`, the node's B rises and every edge on its path from the cues gets stronger; edges off the path are unchanged |
| SC-10 | Revival bonus | A dormant node that is used gains `1 + reviveExtraAccesses` accesses and is no longer dormant |
| SC-11 | Edge floor | An edge unused for 5 years has strength exactly 0.001 and is still traversed |
| SC-12 | Superseded fact | After "favorite color is green" supersedes "blue", the direct lane returns green; blue is in no lane |
| SC-13 | Tail approximation | For 50 accesses spaced 1 day apart with M = 10, approximate B is within 0.1 of exact B |
| SC-14 | Determinism | Running the full suite twice produces byte-identical trace files |
| SC-15 | Pruning and cap | A graph of 50,000 nodes completes a recall with at most `maxExpanded` nodes expanded |

Integration tests add: cross-client recall (written with source `hermes`, recalled by `claude-code`), transcript idempotency (FR-10), queue retry and failure (FR-03), implicit use (FR-23), and in P2 tenant isolation through every route (FR-42).

### 15.4 Benchmark

`pnpm bench` generates a synthetic store with a power-law degree distribution (10,000 nodes and 50,000 edges by default, 100,000 and 500,000 with `--large`), loads it into the test database, runs 1,000 recalls with random cue sets, and prints p50, p95 and p99 for recall with and without the embedding call. A fixed seed makes runs comparable.

## 16. Stack, repo layout and deployment

One repository, one deployable service, one database. Choices favor boring, well-known libraries so a software factory and its local models are on familiar ground.

### 16.1 Stack decisions

| Concern | Choice | Reason |
| --- | --- | --- |
| Runtime | Node.js 22 LTS, TypeScript `strict`, ESM | Primary stack |
| Package manager | pnpm workspaces | Shared `packages/activation` between service and UI |
| HTTP server | Fastify | Schema-first routes, fast, common |
| MCP | `@modelcontextprotocol/sdk`, Streamable HTTP transport | Official SDK |
| Validation | zod | One schema for tools, routes and extraction output |
| Database driver | `pg` (node-postgres) with plain SQL | No ORM; queries are few and specific |
| Vectors | `pgvector` extension, HNSW cosine index | Same database as the graph |
| Model access | OpenAI-compatible HTTP calls to LiteLLM | Existing homelab proxy, Langfuse tracing for free |
| Logging | pino | JSON logs (NFR-13) |
| Tests | Vitest | Unit, replay and integration |
| UI | React, Vite, `react-force-graph-3d` | Section 13 |
| Containers | Docker Compose | Homelab deploy |
| Rust (P3) | pgrx | Postgres extensions in Rust |

### 16.2 Repository layout

```text
recall/
  packages/
    activation/          # pure math, section 10; no runtime deps
      src/  test/
  apps/
    service/             # Fastify + MCP + worker + reinforcement buffer
      src/
        mcp/             # tool definitions (section 8)
        routes/          # hooks, ui, health (sections 9, 12)
        recall/          # pipeline (section 10.5)
        ingest/          # worker, redaction, extraction, resolution (section 11)
        reinforce/       # buffer and flush (section 10.6)
        db/              # pool, tenant transaction helper, queries
        llm/             # LiteLLM client: embed(), extract(), judge()
        config.ts        # params + env, validated with zod
      test/
    ui/                  # React app (section 13)
  db/
    migrations/          # 0001_init.sql, 0002_tenancy.sql, ...
  scenarios/             # replay YAML (section 15)
  integrations/
    claude-code/         # settings.json snippet, .mcp.json snippet, README
    hermes/recall/       # MemoryProvider plugin (section 12.2)
    omp/recall.ts        # extension (section 12.3)
  extension/             # P3: pgrx crate recall_activation
  bench/
  docker-compose.yml
  config/params.json
  docs/smoke.md
```

### 16.3 Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | none, required | Postgres connection for the service role |
| `BIND_ADDRESS` | none, required | LAN or Tailscale address (NFR-10) |
| `PORT` | 7420 | HTTP port |
| `RECALL_TOKEN` | unset | Shared bearer token for hook and MCP routes in P1 |
| `UI_PASSWORD` | none, required | UI login in P1 |
| `SESSION_SECRET` | none, required | Cookie signing |
| `LITELLM_BASE_URL` | none, required | e.g. `http://litellm.lan:4000/v1` |
| `LITELLM_API_KEY` | unset | If the proxy requires one |
| `EMBED_MODEL` | none, required | LiteLLM model alias for embeddings |
| `EMBED_DIM` | 1024 | Must match the model and the migration |
| `EXTRACT_MODEL` | none, required | LiteLLM model alias for extraction and contradiction checks |
| `WORKER_CONCURRENCY` | 2 | Parallel ingest items |
| `USE_FLUSH_MS` | 5000 | Reinforcement flush interval |
| `PREFETCH_TTL_SECONDS` | 600 | Prefetch cache lifetime |
| `CONTEXT_MAX_CHARS` | 4000 | Text form limit |
| `EXTRACT_WINDOW_CHARS` | 6000 | Transcript window size |
| `ALLOW_ALL_INTERFACES` | false | NFR-10 override |
| `ALLOW_REMOTE_MODELS` | false | NFR-12 override |
| `ACTIVATION_BACKEND` | `ts` | P3: `ts` or `pg` |

Model parameters from section 4.5 live in `config/params.json`, overridable per key with `RECALL_PARAM_<NAME>` env vars.

### 16.4 Deployment

Docker Compose with three services on the homelab:

- `db`: `pgvector/pgvector` image on Postgres 17, named volume, not published outside the compose network.
- `recall`: the service image (multi-stage build; the UI is built in the same image), depends on `db`, runs migrations on start, publishes `PORT` on `BIND_ADDRESS`.
- `backup`: runs `pg_dump` nightly into a mounted folder and keeps 14 copies (NFR-15).

LiteLLM and Langfuse already run in the homelab and are reached by URL; they are not part of this compose file. A `test` profile adds a throwaway database for integration tests.

## 17. Delivery plan

Build the math and its test harness first, then the service around it, then clients and UI. The epics below are a suggested breakdown for the backlog; each maps to the FRs it delivers and names what it depends on, so tickets can be ordered automatically.

### 17.1 Phases and exit criteria

**P1 Prototype.** Single user, LAN only. Exit when all of these hold:

- [ ] Scenarios SC-01 to SC-15 pass with default parameters.
- [ ] NFR-01 to NFR-07 and NFR-10 to NFR-13 are met.
- [ ] The client smoke checklist passes for Claude Code, Hermes and omp, including a cross-client recall.
- [ ] The UI plays back a real session recorded from a client.

**P2 Multi-tenancy.** Exit when:

- [ ] FR-29 and FR-38 to FR-44 are done.
- [ ] The tenant isolation test (FR-42) passes on every route.
- [ ] Two tenants run on one deployment with separate tokens and UI logins.

**P3 Rust extension.** Start only when two conditions hold: the activation equations have not changed for several weeks, and benchmarks show spread or neighborhood loading is the latency bottleneck. Exit when:

- [ ] FR-50 to FR-52 are done.
- [ ] The conformance run (FR-51) passes the full scenario suite.
- [ ] Recall p95 with `ACTIVATION_BACKEND=pg` is measured against `ts` and recorded.

### 17.2 Suggested epics

| Epic | Phase | Delivers | Depends on |
| --- | --- | --- | --- |
| E01 Repo scaffold | P1 | pnpm workspace, TS strict, ESLint, Vitest, compose file, CI running lint and tests | none |
| E02 Activation package | P1 | Section 10.1 to 10.4; NFR-07, NFR-16, NFR-17 | E01 |
| E03 Replay harness | P1 | Section 15.2 runner, stub embedder, trace output, SC-01 to SC-15 | E02 |
| E04 Database | P1 | Section 6.1 migrations, migration runner, pool, tenant transaction helper | E01 |
| E05 Config and LLM client | P1 | `config.ts`, `params.json`, `embed()`, `extract()`, `judge()`; FR-27, NFR-12 | E01 |
| E06 Recall pipeline | P1 | FR-11 to FR-18, section 10.5 | E02, E04, E05 |
| E07 Ingest queue and worker | P1 | FR-01 to FR-10, section 11 | E04, E05 |
| E08 Reinforcement | P1 | FR-19 to FR-24, section 10.6 | E02, E04 |
| E09 MCP server | P1 | Section 8, all five tools | E06, E07, E08 |
| E10 HTTP hook routes | P1 | Section 9 hook routes and section 12.1 Claude Code routes; FR-25 | E06, E07, E08 |
| E11 Client integrations | P1 | Claude Code config, Hermes `MemoryProvider` plugin, omp extension, `docs/smoke.md` | E09, E10 |
| E12 UI foundation | P1 | FR-30 to FR-32, FR-36, FR-37; graph route, node route, search route | E02, E04 |
| E13 UI playback and time-lapse | P1 | FR-33 to FR-35; session and trace routes | E12, E06 |
| E14 Operations | P1 | FR-26, FR-28, NFR-13 to NFR-15, benchmark in 15.4 | E04 |
| E15 Multi-tenancy | P2 | Section 6.2, FR-29, FR-38 to FR-44 | P1 exit |
| E16 Rust extension | P3 | FR-50 to FR-52, section 10.7, conformance run | P1 exit, P3 start conditions |

### 17.3 Working rules for the build

- One ticket, one pull request, with its tests in the same PR.
- A change to any default in section 4.5 must come with the scenario results before and after.
- `packages/activation` never imports from `apps/`, Node built-ins, or any I/O library.
- New dependencies need a one-line reason in the PR description.
- Where this PRD and a library's current documentation disagree on an API detail, the library documentation wins; note the difference in the PR.

## 18. Risks and open questions

### 18.1 Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Local extraction model produces noisy entities and duplicates | Graph fills with near-duplicate nodes; fan inflates; recall quality drops | Zod validation and one retry; entity merge by similarity (FR-06); UI shows duplicates for manual merge later; extraction prompt kept narrow |
| Parameters do not transfer from fixtures to real data | Recall too eager or too strict | Tune with real traces replayed through the harness; every trace stores its params; change defaults only with before and after scenario runs |
| Hub nodes (the user, a weekday, a main project) dominate | Recall returns generic items | Fan division (section 4.3); `minSpread`; consider excluding the user node from spreading |
| Models rarely call `mark_used` | Reinforcement never happens | Implicit use from transcripts (FR-23) and fetch-by-id as use (FR-22) |
| Implicit use by label match gives false positives on common words | Unrelated memories reinforced | Word-boundary match; skip labels shorter than 4 characters; revisit with real traces |
| Hook APIs change between client versions | Prefetch or ingest silently stops | Fail-open design; `/healthz` and the UI session list show when a client stopped sending; smoke checklist per client upgrade |
| Whole-graph UI payload grows too large | Slow UI load | P1 limit of 20,000 nodes; paging is open question Q6 |
| Secrets in transcripts | Credentials stored in memory | Redaction before extraction (section 11.2); never store raw transcripts beyond the queue row; queue rows purged after 30 days |

### 18.2 Open questions

- **Q1. Embedding model.** Which local embedding model is served through LiteLLM? This fixes `EMBED_DIM`. The default 1024 assumes a model of that size.
- **Q2. Extraction model.** Which local model handles extraction and contradiction judgments well enough? Run the extraction prompt over 20 real transcripts and compare before choosing.
- **Q3. Exclude the user node from spread?** Every memory links to the user, which makes the user an extreme hub. Fan division may be enough; decide after real data.
- **Q4. Revival boost size.** Is `reviveExtraAccesses = 2` the right strength for a revived dormant memory?
- **Q5. Episode granularity.** One episode per call or meal is clear; for a long coding session, should extraction produce one episode or one per sub-task?
- **Q6. UI paging.** Past 20,000 nodes, load by region, by recency, or by session neighborhood?
- **Q7. Raw transcript retention.** Queue rows are purged after 30 days. Should episodes keep a pointer to raw text for audit, and for how long?
- **Q8. Hermes token in YAML.** ~~Confirm whether Hermes expands environment variables inside `mcp_servers` headers; if not, the token is written literally in `config.yaml`.~~ **Answered 2026-11-17** (map ticket "Verify PRD client-integration claims against live docs"): Hermes expands `${VAR}` in headers from `~/.hermes/.env`, fail-closed when unset. §12.2 config works as written.
- **Q9. omp event payloads.** ~~Confirm the fields of `turn_end` and `agent_end` in omp's `shared-events.ts` before E11.~~ **Answered 2026-11-17** (map ticket "Verify PRD client-integration claims against live docs"): the installed agent is `@earendil-works/pi-coding-agent` 1.5.2; `turn_end` carries `messageEntryId`, `toolResultEntryIds` and outcome — see its findings comment for the full field list. E11 reads the installed types, not the CDN copy.

## 19. Sources

Client integration details were read from these pages on the as-of date; check them again before E11, since hook APIs change between releases.

**Client documentation**

- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks): event names, `http` hook type, `additionalContext`, `last_assistant_message`, `SessionEnd` budget, async hooks.
- [Hermes Agent: building a memory provider plugin](https://hermes-agent.nousresearch.com/docs/developer-guide/memory-provider-plugin): `MemoryProvider` methods, threading rules, plugin layout, `memory.provider`.
- [Hermes Agent: memory providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers): one external provider at a time, behavior when active.
- [Hermes Agent: observer hooks](https://hermes-agent.nousresearch.com/docs/developer-guide/observer-hooks): hook names and which hooks can inject context.
- [Hermes Agent: MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp): `mcp_servers` config, HTTP transport, tool name prefix.
- [omp hook types](verified against the local install: `@earendil-works/pi-coding-agent` 1.5.2, `src/extensibility/hooks/types.ts`): extension events and `before_agent_start` return value. The PRD originally cited a `@oh-my-pi/pi-coding-agent@15.2.4` CDN copy; the installed agent is the earendil package and its `turn_end` payload is richer (carries `messageEntryId`, `toolResultEntryIds`, outcome). E11 must use the installed types.
- [omp coding agent README](https://github.com/can1357/oh-my-pi): MCP discovery uses agent-dir `mcp.json` plus `<project>/.pi/mcp.json`, local providers, memory backends.

**Memory model**

- [Taatgen, Lebiere and Anderson: modeling paradigms in ACT-R](https://www.ai.rug.nl/~niels/publications/taatgenLebiereAnderson.pdf): base-level learning and the activation equation.
- [ACT-R tutorial, unit 5: activation and context](https://cw.fel.cvut.cz/old/_media/courses/a6m33ksy/cvika3_working_memory_actr_activation_and_context_equations.pdf): spreading activation and the fan effect.
- [Petrov 2006: efficient approximation of the base-level equation](https://alexpetrov.com/pub/iccm06): the hybrid approximation in section 4.1.
- [Fisher, Houpt and Gunzelmann 2018: comparison of base-level approximations](https://doi.org/10.1007/s42113-018-0015-3): why the hybrid form over the standard one.
- [Dimov: a familiarity-dependent retrieval threshold in ACT-R](https://escholarship.org/content/qt5gt2v46c/qt5gt2v46c.pdf): basis for the direct lane.
- [MemoryBank](https://arxiv.org/abs/2305.10250): forgetting-curve memory for LLMs.
- [HippoRAG](https://arxiv.org/abs/2405.14831): spreading from query entities over a knowledge graph; node specificity.
- [Graphiti](https://github.com/getzep/graphiti): invalidate-not-delete for superseded facts.

**Libraries**

- [react-force-graph](https://github.com/vasturiano/react-force-graph) and its [README](https://cdn.jsdelivr.net/npm/react-force-graph@1.48.2/README.md): `d3Force`, `nodeThreeObject`, `emitParticle`, `postProcessingComposer`. Verified 2026-11-17 against live docs: use `react-force-graph-3d` **1.29.2** — npm `latest` is a stale stub.
- [pgrx](https://github.com/pgcentralfoundation/pgrx): Rust Postgres extensions.

**Related artifacts**

- [Recall Atlas UI mockup](https://claude.ai/artifact/BnVakaKVVzkiHE3Zd7c9Rf)
- [Architecture whiteboard](https://claude.ai/artifact/9bp4qgG9UjtmFjqnojhmsM)
