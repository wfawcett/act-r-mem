// E09 MCP HTTP registration (§8): mounts the MCP Streamable HTTP transport in
// stateful mode at POST /mcp. One transport + McpServer pair per session
// (keyed by the SDK-generated `mcp-session-id` header); the client name comes
// from the initialize request's clientInfo.name and overrides the argument's
// `client`. When config.recallToken is set, /mcp requires
// `Authorization: Bearer <token>` (401 otherwise). Tool dispatch is logged with
// the Fastify request id via the request-scoped logger.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../config.js';
import { createClient } from '../llm/client.js';
import { pool } from '../db/pool.js';
import { bindLogError } from './tools.js';
import { createMcpServer } from './server.js';
import type { McpToolDeps } from './tools.js';
import type { UseBufferOwner } from '../reinforce/index.js';

export interface McpRegisterDeps {
  config: Config; // registerMcp builds the LiteLLM client and reads recallToken from here
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
}

function unauthorized(reply: FastifyReply): unknown {
  return reply.code(401).send({ error: 'unauthorized' });
}

export async function registerMcp(app: FastifyInstance, deps: McpRegisterDeps): Promise<void> {
  const sessions = new Map<string, SessionEntry>();
  const embed = (text: string) => createClient(deps.config).embed(text);

  app.post('/mcp', async (request, reply) => {
    // §8: bearer-token gate when RECALL_TOKEN is configured.
    if (deps.config.recallToken !== undefined) {
      const header = request.headers.authorization;
      if (header !== `Bearer ${deps.config.recallToken}`) return unauthorized(reply);
    }

    const body = request.body as Record<string, unknown> | undefined;
    const sessionIdHeader = request.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

    let entry = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (entry === undefined) {
      // Only a valid initialize request may open a new session; anything else
      // referencing an unknown session is a 400/404 per the MCP spec.
      if (typeof sessionId === 'string' || !isInitializeRequest(body as never)) {
        return reply.code(400).send({ error: 'invalid mcp request' });
      }
      // §8 preamble: clientInfo.name overrides the argument's client; createMcpServer
      // falls back safely when the name is outside the §8.1 enum.
      const clientName = (
        (body?.params as { clientInfo?: { name?: string } } | undefined)?.clientInfo?.name ?? undefined
      ) as string | undefined;
      const requestId = request.id;
      const toolDeps: McpToolDeps = {
        pool,
        config: deps.config,
        embed,
        useBuffer: (app as unknown as UseBufferOwner).useBuffer,
        log: request.log,
      };
      bindLogError(request.log);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // The initialize response is an SSE stream that stays open, so
        // awaiting handleRequest would never return before the next request.
        // Register the session the moment the transport assigns its id.
        onsessioninitialized: (id) => {
          sessions.set(id, { transport });
        },
      });
      const server = createMcpServer(toolDeps, requestId, clientName);
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id !== undefined) sessions.delete(id);
      };
      await server.connect(transport);

      // The transport writes the HTTP response itself (JSON or SSE stream), so
      // Fastify must not touch the reply afterwards; the promise resolves only
      // when the stream closes, so it is not awaited here.
      reply.hijack();
      void transport.handleRequest(request.raw, reply.raw, body).catch((err) => {
        request.log.error({ err }, '[mcp] transport.handleRequest failed');
      });
    } else {
      // The transport writes the HTTP response itself (JSON or SSE stream), so
      // Fastify must not touch the reply afterwards.
      reply.hijack();
      await entry.transport.handleRequest(request.raw, reply.raw, body);
    }
  });

  app.addHook('onClose', async () => {
    for (const { transport } of sessions.values()) await transport.close();
    sessions.clear();
  });
}
