// §9.2 HTTP surface for card #16: POST /api/ingest/transcript validates the
// body with the same zod schema the enqueue path uses and inserts exactly one
// pending ingest_queue row (FR-01/02) — no LLM, embed, or activation call in
// the request path. Logging is disabled so turn text is never written to
// stdout (§11.2.1, NFR-11).
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { TranscriptRequestSchema, enqueueTranscript } from '../ingest/enqueue.js';

export interface BuildAppOptions {
  config: Config;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({ ok: true }));

  app.post('/api/ingest/transcript', async (request, reply) => {
    const parsed = TranscriptRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid transcript request' });
    }
    const { queued_id } = await enqueueTranscript(parsed.data);
    return reply.status(200).send({ queued_id });
  });

  return app;
}
