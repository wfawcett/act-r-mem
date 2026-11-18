// Phase-1 schema migration runner.
// Reads numbered SQL files from db/migrations, applies the smallest unapplied
// one inside a transaction, and records it in schema_migrations so re-runs are no-ops.
import { Client } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const filenameRe = /^(\d{4})_.+\.sql$/;

// Lists migration files sorted ascending by numeric prefix, throwing if any
// file name does not match NNNN_*.sql.
function loadMigrations() {
  const entries = fs.readdirSync(migrationsDir);
  const migrations = [];
  for (const name of entries) {
    const m = filenameRe.exec(name);
    if (!m) throw new Error(`migration file "${name}" does not match NNNN_*.sql`);
    migrations.push({ number: Number(m[1]), filename: name });
  }
  migrations.sort((a, b) => a.number - b.number);
  return migrations;
}

// Applied migration filenames from schema_migrations. Absent table on first run
// means every file counts as unapplied.
async function appliedFilenames(client) {
  const res = await client.query('SELECT filename FROM schema_migrations');
  return new Set(res.rows.map((r) => r.filename));
}

async function main() {
  const migrations = loadMigrations();
  if (migrations.length === 0) {
    console.log('no migrations to apply');
    return;
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // Ensure the bookkeeping table exists before querying it.
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = await appliedFilenames(client);

    const next = migrations.find((m) => !applied.has(m.filename));
    if (!next) {
      console.log('no migrations to apply');
      return;
    }

    // The next file must continue the sequence from the highest applied number.
    const lastApplied = applied.size > 0
      ? Math.max(...migrations.filter((m) => applied.has(m.filename)).map((m) => m.number))
      : 0;
    if (next.number !== lastApplied + 1) {
      throw new Error(
        `migration ${next.number} (${next.filename}) does not follow applied migration ${lastApplied}`,
      );
    }

    const sql = fs.readFileSync(path.join(migrationsDir, next.filename), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [next.filename]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    console.log(`applied ${next.filename}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
