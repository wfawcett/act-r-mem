// HTTP route registration (card #15 task 6): POST /api/recall/prefetch.
// Plain route-registry adapter: the app passed in must expose a Fastify-shaped
// `post(path, handler)`. Route-level try/catch degrades to { text: "" } —
// never a 500 (FR-17). E09/E10 later add their routes to the same module.
import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import { getParams, type Config } from '../config.js';
import { createClient } from '../llm/client.js';
import type { RecallDeps } from '../recall/deps.js';
import { runPrefetch } from '../recall/prefetch.js';

export interface HttpReply {
  send(payload: unknown): void;
}

// Minimal Fastify-compatible request/reply shapes the handler relies on.
export interface RouteRequest {
  body?: unknown;
}

export interface RouteRegistry {
  post(
    path: string,
    handler: (request: RouteRequest, reply: HttpReply) => Promise<void>,
  ): unknown;
}

export interface PrefetchDeps extends RecallDeps {
  prefetchTtlSeconds: number;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function registerRoutes(
  app: RouteRegistry,
  deps: PrefetchDeps,
): Promise<void> {
  app.post('/api/recall/prefetch', async (request: RouteRequest, reply: HttpReply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const query = readString(body.query);
      const sessionId = readString(body.session_id);
      if (query === undefined || sessionId === undefined) {
        reply.send({ text: '' });
        return;
      }
      const client = readString(body.client) ?? 'local';
      const { text } = await runPrefetch(client, sessionId, query, deps);
      reply.send({ text });
    } catch (err) {
      console.error(
        `[recall] /api/recall/prefetch degraded to empty text: ${(err as Error).message}`,
      );
      reply.send({ text: '' });
    }
  });
}

// Wire the real dependencies: live pool client + LiteLLM embed + loaded params.
// The pool client is acquired per-deps-object and released when the process
// shuts down via disposeRecallDeps; the route handler borrows it from runPrefetch.
export async function buildRecallDeps(config: Config): Promise<PrefetchDeps> {
  const db: PoolClient = await pool.connect();
  const llm = createClient(config);
  return {
    db,
    embed: (text: string) => llm.embed(text),
    params: getParams(),
    prefetchTtlSeconds: config.prefetchTtlSeconds,
    contextMaxChars: config.contextMaxChars,
  };
}
