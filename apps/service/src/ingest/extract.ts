// §11.2 step 3: extraction. Thin wrapper over `client.extract`: builds the
// §11.3 user content (already-redacted text or a serialized transcript window),
// calls the model once per window, and merges the per-window results into one
// `Extraction` by entity `key` — arrays are concatenated across windows and
// deduplicated by key (first occurrence wins). This module performs no DB work.
import type { Extraction } from '../llm/client.js';
import type { createClient } from '../llm/client.js';

type LlmClient = ReturnType<typeof createClient>;

function dedupeByKey<T extends { key: string }>(items: T[]): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    if (!seen.has(item.key)) seen.set(item.key, item);
  }
  return [...seen.values()];
}

function dedupeEdges(
  edges: Extraction['edges'],
): Extraction['edges'] {
  const seen = new Map<string, Extraction['edges'][number]>();
  for (const edge of edges) {
    const k = `${edge.from_key}\u0000${edge.to_key}\u0000${edge.predicate}`;
    if (!seen.has(k)) seen.set(k, edge);
  }
  return [...seen.values()];
}

/** Merge several per-window extractions into one, deduped by `key`. */
export function mergeExtractions(parts: Extraction[]): Extraction {
  return {
    episodes: dedupeByKey(parts.flatMap((p) => p.episodes)),
    entities: dedupeByKey(parts.flatMap((p) => p.entities)),
    facts: dedupeByKey(parts.flatMap((p) => p.facts)),
    edges: dedupeEdges(parts.flatMap((p) => p.edges)),
  };
}

/**
 * Extract memories from one or more windows of already-redacted text and
 * return a single merged `Extraction`. Keys are local to this merged result;
 * `requestId`, when given, is forwarded as the recall_request_id metadata.
 */
export async function extractFromWindows(
  windows: string[],
  llm: LlmClient,
  requestId?: string,
): Promise<Extraction> {
  const parts: Extraction[] = [];
  for (const window of windows) {
    const opts = requestId === undefined ? {} : { requestId };
    parts.push(await llm.extract(window, opts));
  }
  return mergeExtractions(parts);
}
