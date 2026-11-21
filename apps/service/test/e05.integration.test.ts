import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Config, Params } from '../src/config.js';
import { ConfigError, overrideValue, isPrivateLiteLLMUrl, loadConfig } from '../src/config.js';
import { createClient, ExtractionSchema, type Extraction } from '../src/llm/client.js';

const DIM = 768;

/** The client surface this suite exercises — defined locally (no `ReturnType<…>`). */
interface LiteLLMClient {
  embed(text: string, opts?: { requestId?: string }): Promise<number[]>;
  extract(text: string, opts?: { requestId?: string }): Promise<Extraction>;
  judge(a: string, b: string, opts?: { requestId?: string }): Promise<boolean>;
}

interface ChatLogEntry {
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

interface StubState {
  embeddings: number[] | null;
  chatLog: ChatLogEntry[];
  responses: Array<{ choices: Array<{ message: { content: string } }> }>;
}

function makeStub(dim: number): StubState {
  return { embeddings: new Array<number>(dim).fill(0.5), chatLog: [], responses: [] };
}

/** Queue a response whose `content` is the raw JSON string the client will parse. */
function queueChat(state: StubState, content: string) {
  state.responses.push({ choices: [{ message: { content } }] });
}

interface StubHandle {
  url: string;
  state: StubState;
  close: () => Promise<void>;
}

async function startStub(dim: number): Promise<StubHandle> {
  const state = makeStub(dim);
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v != null) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v;
      }
      let body: unknown = undefined;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        /* non-JSON body */
      }
      state.chatLog.push({ path: req.url ?? '', body, headers });

      if ((req.url ?? '').endsWith('/embeddings')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: state.embeddings }] }));
        return;
      }
      if ((req.url ?? '').endsWith('/chat/completions')) {
        const next = state.responses.shift() ?? { choices: [{ message: { content: '{}' } }] };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(next));
        return;
      }
      res.writeHead(404);
      res.end('nope');
    });
  });

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => resolve());
  await promise.catch(reject);

  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => {
      const { promise: closePromise, resolve: closeResolve, reject: closeReject } = Promise.withResolvers<void>();
      server.close((e) => (e ? closeReject(e) : closeResolve()));
      return closePromise;
    },
  };
}

/** Run a test body against its own isolated stub — no shared chatLog between tests. */
async function withStub(dim: number, fn: (stub: StubHandle) => Promise<void>): Promise<void> {
  const stub = await startStub(dim);
  try {
    await fn(stub);
  } finally {
    await stub.close();
  }
}

/** Count /chat/completions calls recorded on a stub's own log. */
function completionCount(state: StubState): number {
  return state.chatLog.filter((c) => c.path.endsWith('/chat/completions')).length;
}

const DEFAULTS: Params = {
  decay: 0.5, recentAccesses: 10, minAgeDays: 0.01, tau: -1.0, noiseScale: 0.35, dormantP: 0.2,
  edgeFloor: 0.001, edgeInitial: 1.0, edgeGain: 0.2, halfLifeDays: { identity: 180, default: 30, incidental: 7 },
  hops: 3, damping: 0.7, pruneEpsilon: 0.0001, maxExpanded: 2000, seedK: 8, seedMinSim: 0.35,
  spreadWeight: 10, minSpread: 0.02, recallThreshold: 0.5, resultLimit: 10, directMinSim: 0.8, reviveExtraAccesses: 2,
};

function baseEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://x@localhost/db',
    BIND_ADDRESS: '127.0.0.1',
    UI_PASSWORD: 'pw',
    SESSION_SECRET: 'secret',
    LITELLM_BASE_URL: 'http://127.0.0.1:9999/v1',
    EMBED_MODEL: 'embed-3',
    EXTRACT_MODEL: 'claude-3-haiku',
    ...over,
  } as NodeJS.ProcessEnv;
}

/** Build a complete, valid Config pointing at the given stub base URL — no casts needed. */
function makeConfig(url: string): Config {
  return {
    params: DEFAULTS,
    databaseUrl: 'postgres://x@localhost/db',
    bindAddress: '127.0.0.1',
    port: 7420,
    recallToken: undefined,
    uiPassword: 'pw',
    sessionSecret: 'secret',
    litellmBaseUrl: url,
    litellmApiKey: undefined,
    embedModel: 'embed-3',
    embedDim: DIM,
    extractModel: 'claude-3-haiku',
    allowRemoteModels: false,
    prefetchTtlSeconds: 600,
    contextMaxChars: 4000,
  };
}

function client(stub: StubHandle): LiteLLMClient {
  return createClient(makeConfig(stub.url));
}

/** Run a config test inside an isolated temp dir that owns its own config/params.json. */
async function withTempParams(fn: () => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'recall-e05-'));
  mkdirSync(path.join(root, 'config'), { recursive: true });
  writeFileSync(path.join(root, 'config', 'params.json'), JSON.stringify(DEFAULTS));
  const originalCwd = process.cwd();
  try {
    process.chdir(root);
    await fn();
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

describe('E05 — config', () => {
  it('loads params from a real config/params.json and classifies private URLs (NFR-12)', async () => {
    await withTempParams(async () => {
      const cfg = loadConfig(baseEnv());
      expect(cfg.params.decay).toBe(0.5);
      expect(cfg.embedDim).toBe(DIM);
      expect(isPrivateLiteLLMUrl('http://127.0.0.1:9000/v1')).toBe(true);
      expect(isPrivateLiteLLMUrl('http://localhost:9000/v1')).toBe(true);
      expect(isPrivateLiteLLMUrl('https://api.openai.com/v1')).toBe(false);
    });
  });

  it('rejects a non-numeric RECALL_PARAM override at startup (spec §E05, FR-27)', async () => {
    await withTempParams(async () => {
      let thrown: unknown;
      try {
        loadConfig(baseEnv({ RECALL_PARAM_DECAY: 'not-a-number' }));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeDefined();
      // A wrong-typed override fails Zod validation against ParamSchema, not a ConfigError.
      const issues = (thrown as { issues?: Array<unknown> }).issues;
      expect(Array.isArray(issues) && issues.length > 0).toBe(true);
    });
  });

  it('honours a numeric RECALL_PARAM_DECAY override', async () => {
    await withTempParams(async () => {
      const cfg = loadConfig(baseEnv({ RECALL_PARAM_DECAY: '42' }));
      expect(cfg.params.decay).toBe(42);
      expect(overrideValue(baseEnv({ RECALL_PARAM_DECAY: '7' }), 'decay')).toBe('7');
    });
  });

  it('refuses a public LiteLLM URL unless ALLOW_REMOTE_MODELS=true (NFR-12)', async () => {
    await withTempParams(async () => {
      expect(() => loadConfig(baseEnv({ LITELLM_BASE_URL: 'https://api.openai.com/v1' }))).toThrow(/private\/local/i);
      expect(() => loadConfig(baseEnv({ LITELLM_BASE_URL: 'https://api.openai.com/v1', ALLOW_REMOTE_MODELS: 'true' }))).not.toThrow();
    });
  });

  it('requires the documented env keys (spec §E05, validation)', async () => {
    await withTempParams(async () => {
      const env = baseEnv();
      delete (env as Record<string, string>)['EMBED_MODEL'];
      expect(() => loadConfig(env)).toThrow(ConfigError);
    });
  });
});

describe('E05 — client against a real LiteLLM stub', () => {
  it('embeds and forwards the recall request id on the wire (NFR-14)', async () => {
    await withStub(DIM, async (stub) => {
      const vec = await client(stub).embed('hello world', { requestId: 'r-123' });
      expect(vec.length).toBe(DIM);

      const embeddings = stub.state.chatLog.filter((c) => c.path.endsWith('/embeddings'));
      expect(embeddings.length).toBe(1);
      const body = embeddings.at(0)?.body as Record<string, unknown>;
      expect((body.model as string)).toBe('embed-3');
      const meta = (body.metadata ?? {}) as { recall_request_id?: string };
      expect(meta.recall_request_id).toBe('r-123');
    });
  });

  it('verifyEmbedDim owns dimension validation; embed passes through any size (spec §E05)', async () => {
    await withStub(DIM, async (stub) => {
      const probe = await client(stub).embed('probe', { requestId: 'match' });
      expect(probe.length).toBe(DIM);
    });

    // embed() never self-checks dims; the 704-dim stub resolves with a short vector.
    await withStub(DIM - 64, async (stub) => {
      const vec = await client(stub).embed('probe');
      expect(vec.length).toBe(DIM - 64);
    });
  });

  it('extracts a valid schema and validates the parsed output', async () => {
    await withStub(DIM, async (stub) => {
      const fresh = makeStub(DIM);
      queueChat(fresh, JSON.stringify({
        episodes: [{ key: 'ep1', label: 'Meeting', summary: 'discussed budget' }],
        entities: [{ key: 'e1', label: 'Acme' }],
        facts: [], edges: [],
      }));
      stub.state.responses.push(...fresh.responses);

      const out = await client(stub).extract('Summarize the meeting');
      expect(ExtractionSchema.safeParse(out).success).toBe(true);
      expect(out.episodes.at(0)?.key).toBe('ep1');
    });
  });

  it('retries exactly once on invalid output, then succeeds (spec §E05, retry-once)', async () => {
    await withStub(DIM, async (stub) => {
      const fresh = makeStub(DIM);
      queueChat(fresh, '{ "bad": true }'); // attempt 1: schema violation -> retry
      queueChat(fresh, JSON.stringify({
        episodes: [], entities: [], facts: [{ key: 'f2', subject_key: 'x', statement: 'ok', half_life_class: 'default' }], edges: [],
      })); // attempt 2: valid
      stub.state.responses.push(...fresh.responses);

      const out = await client(stub).extract('retry me');
      expect(out.episodes.length).toBe(0);
      expect(out.facts.at(0)?.key).toBe('f2');

      expect(completionCount(stub.state)).toBe(2);
      const completions = stub.state.chatLog.filter((c) => c.path.endsWith('/chat/completions'));
      const lastMsg = completions.at(-1)?.body as { messages: Array<{ content: string }> };
      expect(lastMsg?.messages.at(-1)?.content ?? '').toMatch(/invalid/i);
    });
  });

  it('propagates after the single retry rather than looping (spec §E05, bounded)', async () => {
    await withStub(DIM, async (stub) => {
      const fresh = makeStub(DIM);
      queueChat(fresh, 'not json at all'); // attempt 1: JSON.parse fails
      queueChat(fresh, 'still invalid {{{'); // attempt 2: JSON.parse fails -> throw
      stub.state.responses.push(...fresh.responses);

      await expect(client(stub).extract('always bad')).rejects.toBeDefined();

      expect(completionCount(stub.state)).toBe(2);
    });
  });

  it('judge returns boolean for yes/no and errors on non-boolean output', async () => {
    await withStub(DIM, async (stub) => {
      const freshYes = makeStub(DIM);
      queueChat(freshYes, 'yes');
      const freshNo = makeStub(DIM);
      queueChat(freshNo, 'no');
      const freshMaybe = makeStub(DIM);
      queueChat(freshMaybe, 'maybe a little');

      stub.state.responses.push(...freshYes.responses, ...freshNo.responses, ...freshMaybe.responses);

      await expect(client(stub).judge('cats are warm', 'cats are cold')).resolves.toBe(true);
      await expect(client(stub).judge('water is dry', 'water is wet')).resolves.toBe(false);
      await expect(client(stub).judge('a', 'b')).rejects.toBeDefined();
    });
  });
});
