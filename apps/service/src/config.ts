import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// --- Params (PRD §4.5, mirrored exactly in config/params.json) ---------------
const RecordSchema = <S extends z.ZodTypeAny>(value: S) => z.record(z.string(), value);

export const ParamSchema = z.object({
  decay: z.number(),
  recentAccesses: z.number().int().positive(),
  minAgeDays: z.number(),
  tau: z.number(),
  noiseScale: z.number(),
  dormantP: z.number(),
  edgeFloor: z.number().nonnegative(),
  edgeInitial: z.number(),
  edgeGain: z.number(),
  halfLifeDays: RecordSchema(z.number().int().positive()),
  hops: z.number().int().positive(),
  damping: z.number(),
  pruneEpsilon: z.number().nonnegative(),
  maxExpanded: z.number().int().positive(),
  seedK: z.number().int().positive(),
  seedMinSim: z.number(),
  spreadWeight: z.number(),
  minSpread: z.number(),
  recallThreshold: z.number(),
  resultLimit: z.number().int().positive(),
  directMinSim: z.number(),
  reviveExtraAccesses: z.number().int().nonnegative(),
});

export type Params = z.infer<typeof ParamSchema>;

// --- Runtime configuration (§16.3) -------------------------------------------
export interface Config {
  params: Params;
  databaseUrl: string;
  bindAddress: string;
  port: number;
  recallToken?: string | undefined;
  uiPassword: string;
  sessionSecret: string;
  litellmBaseUrl: string;
  litellmApiKey?: string | undefined;
  embedModel: string;
  embedDim: number;
  extractModel: string;
  extractWindowChars: number;
  workerConcurrency: number;
  allowRemoteModels: boolean;
  prefetchTtlSeconds: number;
  contextMaxChars: number;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
  constructor(message: string) {
    super(message);
  }
}

// --- NFR-12: refuse non-private LiteLLM base URLs unless explicitly allowed ----
function classifyHost(host: string): 'loopback' | 'rfc1918' | 'ula' | 'lan-name' | 'public' {
  const h = host.toLowerCase();
  if (h === '::1' || (h.startsWith('::ffff:') && /^\d+\.\d+\.\d+\.\d+$/.test(h.slice(7)))) {
    const ipv4 = h.slice(7);
    if (/^127\./.test(ipv4)) return 'loopback';
  }
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan')) return 'lan-name';
  if (h === '127.0.0.1' || /^127\.\d+\.\d+\.\d+$/.test(h)) return 'loopback';
  if (/^10\./.test(h)) return 'rfc1918';
  if (/^192\.168\./.test(h)) return 'rfc1918';
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return 'rfc1918';
  if (h.startsWith('fe80:') || h.startsWith('fd')) return 'ula';
  return 'public';
}

export function isPrivateLiteLLMUrl(url: string): boolean {
  const host = new URL(url).host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return classifyHost(host) !== 'public';
}

// --- RECALL_PARAM_<NAME> overrides (FR-27) -----------------------------------
function overrideEnvKey(name: string): string {
  return 'RECALL_PARAM_' + name.replace(/\./g, '_').toUpperCase();
}

function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

function readBool(env: NodeJS.ProcessEnv, key: string): boolean {
  const v = env[key];
  return v !== undefined && v.trim().toLowerCase() === 'true';
}

const DEFAULTS = {
  port: 7420,
  workerConcurrency: 2,
  useFlushMs: 5000,
  prefetchTtlSeconds: 600,
  contextMaxChars: 4000,
  extractWindowChars: 6000,
  embedDim: 768,
} as const;

export function overrideValue(overrides: NodeJS.ProcessEnv, name: string): string | undefined {
  return overrides[overrideEnvKey(name)];
}

function parseParamOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('RECALL_PARAM_') || value === undefined) continue;
    const name = key.slice('RECALL_PARAM_'.length).toLowerCase();
    result[name] = coerceOverride(value);
  }
  return result;
}

function coerceOverride(raw: string): string | number {
  const n = Number.parseFloat(raw);
  if (!Number.isNaN(n) && /^-?\d+(\.\d+)?$/.test(raw)) return n;
  return raw;
}

function applyParamOverrides(base: Params, overrides: Record<string, unknown>): Params {
  const result: Params = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && key in result) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

// --- config/params.json loader (FR-27) ---------------------------------------
function loadParamsFile(envPath = 'config/params.json'): Params {
  const raw = fs.readFileSync(path.resolve(process.cwd(), envPath), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config/params.json is not valid JSON: ${(err as Error).message}`);
  }
  return ParamSchema.parse(parsed);
}

function assertRequired(env: NodeJS.ProcessEnv, keys: string[]): void {
  const missing = keys.filter((k) => env[k] === undefined || env[k] === '');
  if (missing.length > 0) {
    throw new ConfigError(`Missing required environment variable(s): ${missing.join(', ')}`);
  }
}

function assertPrivateLiteLLMUrl(url: string, allowRemoteModels: boolean): void {
  if (!allowRemoteModels && !isPrivateLiteLLMUrl(url)) {
    throw new ConfigError(
      `LITELLM_BASE_URL must point at a private/local address unless ALLOW_REMOTE_MODELS=true (NFR-12). Got ${url}`,
    );
  }
}

// --- config.ts entry point ---------------------------------------------------
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const params = applyParamOverrides(loadParamsFile(), parseParamOverrides(env));
  ParamSchema.parse(params);

  assertRequired(env, [
    'DATABASE_URL',
    'BIND_ADDRESS',
    'UI_PASSWORD',
    'SESSION_SECRET',
    'LITELLM_BASE_URL',
    'EMBED_MODEL',
    'EXTRACT_MODEL',
  ]);

  const allowRemoteModels = readBool(env, 'ALLOW_REMOTE_MODELS');
  assertPrivateLiteLLMUrl(env.LITELLM_BASE_URL ?? '', allowRemoteModels);

  return {
    params,
    databaseUrl: env.DATABASE_URL as string,
    bindAddress: env.BIND_ADDRESS as string,
    port: readInt(env, 'PORT', DEFAULTS.port),
    recallToken: env.RECALL_TOKEN ?? undefined,
    uiPassword: env.UI_PASSWORD as string,
    sessionSecret: env.SESSION_SECRET as string,
    litellmBaseUrl: env.LITELLM_BASE_URL as string,
    litellmApiKey: env.LITELLM_API_KEY ?? undefined,
    embedModel: env.EMBED_MODEL as string,
    embedDim: readInt(env, 'EMBED_DIM', DEFAULTS.embedDim),
    extractModel: env.EXTRACT_MODEL as string,
    extractWindowChars: readInt(env, 'EXTRACT_WINDOW_CHARS', DEFAULTS.extractWindowChars),
    workerConcurrency: readInt(env, 'WORKER_CONCURRENCY', DEFAULTS.workerConcurrency),
    allowRemoteModels,
    prefetchTtlSeconds: readInt(env, 'PREFETCH_TTL_SECONDS', 600),
    contextMaxChars: readInt(env, 'CONTEXT_MAX_CHARS', 4000),
  };
}

let _effectiveParams: Params | undefined;
export function getParams(): Params {
  if (_effectiveParams === undefined) {
    throw new ConfigError('getParams() called before loadConfig()');
  }
  return _effectiveParams;
}

export function setEffectiveParams(params: Params): void {
  _effectiveParams = params;
}

// --- EMBED_DIM verification (spec §E05) --------------------------------------
import { createClient } from './llm/client.js';

export async function verifyEmbedDim(config: Config): Promise<void> {
  const { embed } = createClient(config);
  const vector = await embed('probe', { requestId: 'startup-probe' });
  if (!Array.isArray(vector)) {
    throw new ConfigError(`EMBED_DIM probe returned a non-array vector from ${config.embedModel}`);
  }
  if (vector.length !== config.embedDim) {
    throw new ConfigError(
      `EMBED_DIM mismatch: model ${config.embedModel} returned ${vector.length} dims; expected ${config.embedDim}`,
    );
  }
}
