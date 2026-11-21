// Benchmark fixture loader (card #15, task 8): a PRD §15.4-scale synthetic
// store — 10,000 nodes and 50,000 edges by default, a power-law-ish degree
// distribution, and deterministic pseudo-random embeddings on a subset —
// seeded straight into the test database with `pg`. Seeding assumes the
// phase-1 schema is already applied (`node db/migrate.mjs`).
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://recall:recall@localhost:5433/recall_test';

// mulberry32: tiny deterministic PRNG so runs are comparable (PRD §15.4).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIM = 768;
const KINDS = ['entity', 'fact', 'episode'];
const PREDICATES = ['with', 'about', 'ate', 'is', 'followed by', 'at'];

/** Normalized dense vector from the PRNG — unit length so cosine sim is a plain dot product. */
function randomUnitVector(rand) {
  const v = new Array(DIM);
  let norm = 0;
  for (let i = 0; i < DIM; i++) {
    v[i] = rand() * 2 - 1;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

/**
 * Seed the benchmark fixture. Returns { nodes, edges } — the row counts actually
 * inserted (duplicate random edge pairs are skipped via ON CONFLICT DO NOTHING).
 */
export async function loadBenchFixture(
  db,
  { nodes = 10_000, edges = 50_000, embedded = 1_000, seed = 42 } = {},
) {
  const rand = mulberry32(seed);
  const day = 86_400_000;
  const now = Date.now();

  // --- nodes ---------------------------------------------------------------
  for (let start = 0; start < nodes; start += 500) {
    const end = Math.min(start + 500, nodes);
    const values = [];
    const params = [];
    let p = 0;
    for (let i = start; i < end; i++) {
      const kind = KINDS[i % KINDS.length];
      const label = `node-${i}`;
      const content = kind === 'entity' ? null : `${kind} ${i} content for the benchmark fixture`;
      const created = now - Math.floor(rand() * 365) * day;
      const accessed = created + Math.floor(rand() * (now - created));
      const isEntity = kind === 'entity';
      const base = p;
      params.push(
        kind, label, content, label.toLowerCase(), i < embedded ? '[' + randomUnitVector(rand).join(',') + ']' : null,
        created, Math.max(1, Math.floor(rand() * 20)), accessed,
      );
      p += 8;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::vector, ` +
        `to_timestamp($${base + 6} / 1000.0), $${base + 7}, ARRAY(SELECT to_timestamp($${base + 8} / 1000.0)))`,
      );
      void isEntity;
    }
    await db.query(
      `INSERT INTO nodes (kind, label, content, label_norm, embedding, created_at, access_count, recent_access)
       VALUES ${values.join(', ')}`,
      params,
    );
  }

  // --- edges (power-law-ish: prefer low-index hubs as endpoints) -----------
  let inserted = 0;
  for (let start = 0; start < edges; start += 1000) {
    const end = Math.min(start + 1000, edges);
    const values = [];
    const params = [];
    let p = 0;
    for (let i = start; i < end; i++) {
      // Half the endpoints come from the first 10% of node ids (hubs).
      const pick = () => {
        if (rand() < 0.5) return Math.floor(rand() * Math.max(1, Math.floor(nodes / 10)));
        return Math.floor(rand() * nodes);
      };
      const src = 1 + pick();
      let dst = 1 + pick();
      if (dst === src) dst = ((src + 1 - 1) % nodes) + 1;
      const strength = rand() < 0.9 ? rand() * 0.9 + 0.1 : 0.001;
      const base = p;
      params.push(src, dst, PREDICATES[i % PREDICATES.length], strength);
      p += 4;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
    }
    const res = await db.query(
      `INSERT INTO edges (src, dst, predicate, strength) VALUES ${values.join(', ')}
       ON CONFLICT DO NOTHING`,
      params,
    );
    inserted += res.rowCount ?? 0;
  }

  return { nodes, edges: inserted };
}

// CLI: `node load-bench-fixture.mjs [nodes] [edges]` — migrates, then seeds.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { execFileSync } = await import('node:child_process');
  const path = await import('node:path');
  execFileSync('node', [path.resolve(process.cwd(), '..', '..', 'db', 'migrate.mjs')], {
    encoding: 'utf8', env: { ...process.env, DATABASE_URL }, stdio: 'inherit',
  });
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  const t = Date.now();
  const counts = await loadBenchFixture(client);
  console.log(`seeded ${counts.nodes} nodes / ${counts.edges} edges in ${Date.now() - t} ms`);
  await client.end();
}
