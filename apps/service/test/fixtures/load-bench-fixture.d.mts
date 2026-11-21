// Types for the benchmark fixture loader (task 8).
export interface FixtureCounts {
  nodes: number;
  edges: number;
}
export declare function loadBenchFixture(
  db: { query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }> },
  opts?: { nodes?: number; edges?: number; embedded?: number; seed?: number },
): Promise<FixtureCounts>;
