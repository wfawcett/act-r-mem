export type Chunk = { name: string; slotValues: string[] };
export const BASE_LEVEL = -1.0;
export const MATCH_STRENGTH = 1.0;

export function activation(chunks: Chunk[], context: string[]): number {
  let total = 0;
  for (const chunk of chunks) {
    const matches = chunk.slotValues.filter((v) => context.includes(v)).length;
    total += BASE_LEVEL + matches * MATCH_STRENGTH;
  }
  return total;
}
