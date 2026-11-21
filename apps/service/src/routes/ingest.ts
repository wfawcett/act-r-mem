// §9.2 HTTP surface for card #16: POST /api/ingest/transcript validates the
// body with the same zod schema the enqueue path uses and inserts exactly one
// pending ingest_queue row (FR-01/02) — no LLM, embed, or activation call in
// the request path. Logging is disabled so turn text is never written to
// stdout (§11.2.1, NFR-11).
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { TranscriptRequestSchema, enqueueTranscript } from '../ingest/enqueue.js';
import { attachUseBuffer } from '../reinforce/index.js';
import { registerMcp } from '../mcp/register.js';
import { pool } from '../db/pool.js';

export interface BuildAppOptions {
  config: Config;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // One UseBuffer per app instance (§16.4): batches use events, flushes on the
  // interval/threshold and on SIGTERM (FR-19/NFR-06). Routes (E09/E10) call
  // app.useBuffer.add.
  const useBuffer = attachUseBuffer(app, { pool, params: opts.config.params, useFlushMs: opts.config.useFlushMs });
  app.addHook('onClose', async () => {
    await useBuffer.flush();
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.post('/api/ingest/transcript', async (request, reply) => {
    const parsed = TranscriptRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid transcript request' });
    }
    const { queued_id } = await enqueueTranscript(parsed.data);
    return reply.status(200).send({ queued_id });
  });

  // E09: mount the MCP Streamable HTTP transport at POST /mcp. E10 hook
  // routes (/api/recall/prefetch, /api/mark-used, /api/sessions/end) stay out
  // of buildApp — they belong to the card #19 hook app.
  await registerMcp(app, { config: opts.config });

  return app;
}
