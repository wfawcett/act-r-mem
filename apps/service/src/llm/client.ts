import { z } from 'zod';
import type { Config } from '../config.js';

export const ExtractionSchema = z.object({
  episodes: z.array(z.object({ key: z.string(), label: z.string(), summary: z.string(), occurred_at: z.string().optional() })),
  entities: z.array(z.object({ key: z.string(), label: z.string(), aliases: z.array(z.string()).optional() })),
  facts: z.array(z.object({ key: z.string(), subject_key: z.string(), statement: z.string(), half_life_class: z.enum(['identity', 'default', 'incidental']) })),
  edges: z.array(z.object({ from_key: z.string(), to_key: z.string(), predicate: z.string(), half_life_class: z.enum(['identity', 'default', 'incidental']) })),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

export interface ClientOptions { requestId?: string; }
interface LiteLLMRequestHeaders { Authorization: string; 'Content-Type': string; }

function authHeader(config: Config): LiteLLMRequestHeaders {
  return { Authorization: `Bearer ${config.litellmApiKey ?? ''}`, 'Content-Type': 'application/json' };
}

export function createClient(config: Config) {
  const baseURL = config.litellmBaseUrl.replace(/\/$/, '');
  const headers = authHeader(config);
  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${baseURL}/${path}`, { method: 'POST', headers: headers as unknown as Record<string, string>, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`LiteLLM ${path} failed with HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  function embed(text: string, opts?: ClientOptions): Promise<number[]> {
    const body = { model: config.embedModel, input: text, metadata: { recall_request_id: opts?.requestId ?? null } };
    return post<{ data?: [{ embedding?: number[] }] }>(`embeddings`, body).then((r) => {
      const vec = r.data?.[0]?.embedding;
      if (!Array.isArray(vec)) throw new Error('LiteLLM embed returned no vector');
      return vec;
    });
  }

  async function extract(text: string, opts?: ClientOptions): Promise<Extraction> {
    const model = (config as { extractModel: string }).extractModel;
    let attempts = 0;
    const attempt = (userContent: string): Promise<Extraction> => {
      attempts += 1;
      return post<{ choices?: [{ message?: { content?: string } }] }>(`chat/completions`, {
        model, temperature: 0, messages: [
          { role: 'system', content: 'Respond ONLY with a JSON object matching the schema.' },
          { role: 'user', content: userContent },
        ],
        metadata: { recall_request_id: opts?.requestId ?? null },
      }).then((r) => {
        const raw = r.choices?.[0]?.message?.content;
        if (raw === undefined) throw new Error('LiteLLM extract returned no content');
        return ExtractionSchema.parse(JSON.parse(raw));
      });
    };
    try {
      return await attempt(text);
    } catch (firstErr) {
      if (attempts >= 2) throw firstErr;
      const detail = firstErr instanceof Error ? firstErr.message : String(firstErr);
      return await attempt(text + `\n\nModel output was invalid. Fix these errors and respond with valid JSON only:\n${detail}`);
    }
  }

  async function judge(newStatement: string, candidateStatement: string, opts?: ClientOptions): Promise<boolean> {
    const model = (config as { extractModel: string }).extractModel;
    const res = await post<{ choices?: [{ message?: { content?: string } }] }>(`chat/completions`, {
      model, temperature: 0, messages: [
        { role: 'system', content: 'Answer yes or no.' },
        { role: 'user', content: `Does "${candidateStatement}" contradict "${newStatement}"? Answer only "yes" or "no."` },
      ],
      metadata: { recall_request_id: opts?.requestId ?? null },
    });
    const c = res.choices?.[0]?.message?.content?.trim().toLowerCase() ?? '';
    if (c.startsWith('yes')) return true;
    if (c.startsWith('no')) return false;
    throw new Error(`LiteLLM judge returned non-boolean: ${JSON.stringify(res)}`);
  }

  return { embed, extract, judge };
}
