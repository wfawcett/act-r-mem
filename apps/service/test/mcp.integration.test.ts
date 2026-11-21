// E09 MCP server integration tests (card #18, plan task 6). Boots buildApp
// against the compose test-db (migrations via db/migrate.mjs, same pattern as
// recall.integration.test.ts) and drives an SDK `Client` over
// `StreamableHTTPClientTransport` through all five tools: exact §8 descriptions,
// §8 output shapes, §8.6 validation messages, the internal-error message, and
// the transport clientInfo.name override.
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// 60s: app boot, SDK handshakes and DB polling on a loaded box.
vi.setConfig({ testTimeout: 60000 });

const MIGRATE = path.resolve(process.cwd(), '..', '..', 'db', 'migrate.mjs');
const DATABASE_URL = 'postgres://recall:recall@127.0.0.1:5433/recall_test';
const TENANT = 'local';

process.env.DATABASE_URL = DATABASE_URL;
// pool.ts and enqueue.ts read DATABASE_URL at import time — import after env set.
const { pool } = await import('../src/db/pool.js');
const { buildApp } = await import('../src/routes/ingest.js');
const { loadConfig } = await import('../src/config.js');
import type { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';

execFileSync('node', [MIGRATE], { encoding: 'utf8' });
await pool.query(`TRUNCATE ingest_queue, recall_trace, nodes, edges`);

process.chdir('../..'); // loadConfig reads config/params.json from cwd

// --- embed stub ---------------------------------------------------------------
// Tiny LiteLLM stub: constant-vector embeddings (every node is mutually
// similar, so recall is deterministic) with a `failEmbeds` toggle that makes
// /embeddings return 500 to exercise the internal-error path. Remember only
// enqueues (no LLM in the request path), so no chat endpoint is needed.
const stubState = { failEmbeds: false };
const embedServer: Server = createServer(async (req, res) => {
  await new Promise<string>((resolve) => {
    let buf = '';
    req.on('data', (c: Buffer) => (buf += c));
    req.on('end', () => resolve(buf));
  });
  if ((req.url ?? '').endsWith('/embeddings') && !stubState.failEmbeds) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ embedding: new Array<number>(768).fill(0.5) }] }));
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // "Failing" mode returns a wrong-dimension vector: the recall pipeline
    // swallows embed failures, but the mismatched pgvector comparison inside
    // the recall transaction throws — a deterministic internal error.
    res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
  }
});
embedServer.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => embedServer.once('listening', resolve));
const embedUrl = `http://127.0.0.1:${(embedServer.address() as AddressInfo).port}`;

const baseConfig = loadConfig({
  DATABASE_URL,
  BIND_ADDRESS: '127.0.0.1',
  UI_PASSWORD: 'x',
  SESSION_SECRET: 'x',
  LITELLM_BASE_URL: embedUrl,
  EMBED_MODEL: 'stub',
  EXTRACT_MODEL: 'stub',
});
const config = { ...baseConfig, useFlushMs: 200 }; // fast flush so mark_used lands observably

const app = await buildApp({ config });
await app.listen({ port: 0, host: '127.0.0.1' });
const serviceUrl = `http://127.0.0.1:${(app.server!.address() as AddressInfo).port}`;

// --- fixture: two nodes + one edge in the 'local' tenant -----------------------
const vec = `'[${new Array<number>(768).fill(0.5).join(',')}]'`;
const seed = await pool.query<{ id: string }>(`
  WITH a AS (
    INSERT INTO nodes (tenant_id, kind, label, label_norm, embedding)
    VALUES ('local', 'entity', 'Alice', 'alice', ${vec}::vector) RETURNING id),
  f AS (
    INSERT INTO nodes (tenant_id, kind, label, content, label_norm, embedding)
    VALUES ('local', 'fact', 'alice-hiking', 'Alice likes hiking', 'alice-hiking', ${vec}::vector)
    RETURNING id),
  e AS (
    INSERT INTO edges (tenant_id, src, dst, predicate)
    SELECT 'local', a.id, f.id, 'about' FROM a, f RETURNING id)
  SELECT a.id AS alice, f.id AS fact FROM a, f`);
const aliceId = Number(seed.rows[0].alice);
const factId = Number(seed.rows[0].fact);

// --- helpers -------------------------------------------------------------------
async function connect(impl: { name: string; version: string }): Promise<McpClient> {
  const client = new Client(impl);
  const transport = new StreamableHTTPClientTransport(new URL(`${serviceUrl}/mcp`));
  await client.connect(transport);
  return client;
}

interface ToolOutcome {
  isError?: boolean;
  text: string;
}

async function call(client: McpClient, name: string, args: unknown): Promise<ToolOutcome> {
  const result = (await client.callTool({ name, arguments: args as never })) as {
    isError?: boolean;
    content?: { type: string; text: string }[];
  };
  return { isError: result.isError, text: result.content?.[0]?.text ?? '' };
}

async function callOk<T>(client: McpClient, name: string, args: unknown): Promise<T> {
  const outcome = await call(client, name, args);
  expect(outcome.isError).toBeUndefined();
  return JSON.parse(outcome.text) as T;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

afterAll(async () => {
  await app.close(); // flushes the use buffer via the onClose hook
  embedServer.close();
});

// Exact §8 description strings (PRD §8.1–8.5, mirrored in server.ts).
const DESCRIPTIONS: Record<string, string> = {
  remember:
    'Save something worth remembering about the user or their work. Returns immediately; processing happens in the background.',
  recall:
    "Recall memories related to the current conversation. Pass the user's message or a short description of what you need. Call mark_used with the ids you actually rely on.",
  mark_used:
    'Tell memory which recalled ids you actually used in your answer. This strengthens them.',
  get_memory: 'Get one memory by id, with its connections.',
  forget: 'Forget a memory the user asked you to forget. Use only when the user asks.',
};

describe('mcp server integration', () => {
  let client: McpClient;
  let traceId: number | undefined;

  beforeAll(async () => {
    client = await connect({ name: 'vitest', version: '1.0' });
  });

  afterAll(async () => {
    await client.close();
  });

  it('lists the five tools with the exact §8 descriptions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'forget', 'get_memory', 'mark_used', 'recall', 'remember',
    ]);
    for (const tool of tools) {
      expect(tool.description).toBe(DESCRIPTIONS[tool.name]);
    }
  });

  it('remember queues an ingest_queue row and returns its id', async () => {
    const { queued_id } = await callOk<{ queued_id: number }>(client, 'remember', {
      text: 'Remember Alice likes hiking',
      client: 'claude-code',
      session_id: 's-mcp',
    });
    expect(Number.isInteger(queued_id)).toBe(true);
    const row = await pool.query<{ kind: string; client: string; status: string }>(
      `SELECT kind, client, status FROM ingest_queue WHERE id = $1`, [queued_id],
    );
    expect(row.rows[0]).toMatchObject({ kind: 'remember', client: 'claude-code', status: 'pending' });
  });

  it('remember rejects empty text with the §8.6 message', async () => {
    const outcome = await call(client, 'remember', { text: '' });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toBe('text is empty');
  });

  it('recall returns { trace_id, memories, text } and finds the seeded fact', async () => {
    const result = await callOk<{
      trace_id: number | undefined;
      memories: { id: number; kind: string; label: string; content: string | null; lane: string }[];
      text: string;
    }>(client, 'recall', { query: 'Alice hiking' });
    expect(typeof result.trace_id).toBe('number');
    traceId = result.trace_id;
    expect(result.memories.some((m) => m.id === factId)).toBe(true);
    expect(result.text).toContain(String(factId));
  });

  it('recall rejects an empty query with the §8.6 message', async () => {
    const outcome = await call(client, 'recall', { query: '' });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toBe('query is empty');
  });

  it('mark_used accepts ids and appends used_ids on the trace after flush', async () => {
    const { accepted } = await callOk<{ accepted: number }>(client, 'mark_used', {
      trace_id: traceId,
      ids: [aliceId, factId],
    });
    expect(accepted).toBe(2);
    await waitFor(async () => {
      const { rows } = await pool.query<{ used_ids: string[] }>(
        `SELECT used_ids FROM recall_trace WHERE id = $1`, [traceId],
      );
      const used = (rows[0]?.used_ids ?? []).map(Number);
      return used.includes(aliceId) && used.includes(factId);
    });
  });

  it('mark_used rejects more than 50 ids with the §8.6 message', async () => {
    const outcome = await call(client, 'mark_used', {
      ids: Array.from({ length: 51 }, (_, i) => i + 1),
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toBe('ids must contain 1..50 ids');
  });

  it('get_memory returns the node plus its connections', async () => {
    const memory = await callOk<{
      id: number;
      kind: string;
      label: string;
      content: string | null;
      connections: { id: number; predicate: string; kind: string }[];
    }>(client, 'get_memory', { id: factId });
    expect(memory).toMatchObject({ id: factId, kind: 'fact', content: 'Alice likes hiking' });
    expect(memory.connections.some((c) => c.id === aliceId && c.predicate === 'about')).toBe(true);
  });

  it('get_memory rejects an unknown id with the §8.6 message', async () => {
    const outcome = await call(client, 'get_memory', { id: 999999 });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toBe('No memory with id 999999');
  });

  it('forget invalidates the node, then reports a missing id on repeat', async () => {
    const result = await callOk<{ forgotten: true }>(client, 'forget', {
      id: aliceId,
      reason: 'user asked',
    });
    expect(result).toEqual({ forgotten: true });
    const { rows } = await pool.query<{ invalid_at: Date | null }>(
      `SELECT invalid_at FROM nodes WHERE id = $1`, [aliceId],
    );
    expect(rows[0].invalid_at).not.toBeNull();
    const repeat = await call(client, 'forget', { id: aliceId });
    expect(repeat.isError).toBe(true);
    expect(repeat.text).toBe(`No memory with id ${aliceId}`);
  });

  it('internal failures return the §8.6 generic message and keep the session alive', async () => {
    stubState.failEmbeds = true;
    try {
      const outcome = await call(client, 'recall', { query: 'anything' });
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toBe('Memory is unavailable right now');
    } finally {
      stubState.failEmbeds = false;
    }
    // The session still works after the internal error.
    const ok = await call(client, 'recall', { query: 'hiking' });
    expect(ok.isError).toBeUndefined();
  });
});

describe('mcp transport client-name override', () => {
  it('clientInfo.name overrides the remember client when it is in the enum', async () => {
    const client = await connect({ name: 'omp', version: '1.0' });
    try {
      const { queued_id } = await callOk<{ queued_id: number }>(client, 'remember', {
        text: 'override check',
        client: 'manual',
      });
      const row = await pool.query<{ client: string }>(
        `SELECT client FROM ingest_queue WHERE id = $1`, [queued_id],
      );
      expect(row.rows[0].client).toBe('omp');
    } finally {
      await client.close();
    }
  });

  it('falls back to the argument client when clientInfo.name is outside the enum', async () => {
    const client = await connect({ name: 'superweird', version: '1.0' });
    try {
      const { queued_id } = await callOk<{ queued_id: number }>(client, 'remember', {
        text: 'fallback check',
        client: 'manual',
      });
      const row = await pool.query<{ client: string }>(
        `SELECT client FROM ingest_queue WHERE id = $1`, [queued_id],
      );
      expect(row.rows[0].client).toBe('manual');
    } finally {
      await client.close();
    }
  });
});
