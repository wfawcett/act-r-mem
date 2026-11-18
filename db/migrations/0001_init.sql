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
  embedding      vector(768),                      -- null until the worker embeds it
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

