// Prefetch context for a (client, session): per-(client, session) cache with TTL,
// 2 s internal budget; budget expiry or embed failure returns { text: "" }
// (FR-17, NFR-04). Never reinforces state — this only reads.
import type { RecallDeps } from './deps.js';
import { recall } from './pipeline.js';

const BUDGET_MS = 2000;

interface CacheEntry {
  text: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(client: string, sessionId: string): string {
  return `${client}\u0000${sessionId}`;
}

export function clearPrefetchCache(): void {
  cache.clear();
}

export async function runPrefetch(
  client: string,
  sessionId: string,
  query: string,
  deps: RecallDeps & { prefetchTtlSeconds: number },
): Promise<{ text: string }> {
  const key = cacheKey(client, sessionId);
  const startedAt = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > startedAt) {
    // Cache hit returns the cached text without embedding (FR-17).
    return { text: hit.text };
  }

  // 2 s internal budget: race the embedding call and the whole pipeline
  // against AbortSignal.timeout(2000); expiry or embed failure -> { text: "" }.
  const budget = AbortSignal.timeout(BUDGET_MS);
  const race = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([
      p,
      new Promise<never>((_, reject) => {
        budget.addEventListener('abort', () => reject(budget.reason), { once: true });
      }),
    ]);

  try {
    const result = await race(
      recall(
        { tenant: 'local', sessionId, query, explicitCues: [], client },
        {
          ...deps,
          // Embed under the budget: the wrapper races each embed call
          // (including those the pipeline makes) against the abort signal.
          embed: (text: string) => race(deps.embed(text)),
        },
      ),
    );

    cache.set(key, {
      text: result.text,
      expiresAt: Date.now() + deps.prefetchTtlSeconds * 1000,
    });
    return { text: result.text };
  } catch (err) {
    console.error(`[recall] prefetch degraded to empty text: ${(err as Error).message}`);
    return { text: '' };
  }
}
