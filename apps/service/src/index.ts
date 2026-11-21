// §6 service entrypoint: load config → run the schema migration runner →
// listen → start the background worker (§11.1) → on SIGTERM/SIGINT stop the
// worker (draining in-flight items) and close the HTTP server.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Config } from './config.js';
import { pool } from './db/pool.js';
import { startWorker, type WorkerHandle } from './ingest/worker.js';
import { buildApp } from './routes/ingest.js';

// db/migrate.mjs lives at the repo root; resolve it relative to this module so
// it works both from src (tsx) and from dist.
function migrateScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // <root>/apps/service/dist/index.js | <root>/apps/service/src/index.ts
  const root = here.replace(/[/\\]apps[/\\]service[/\\](dist|src)[/\\]?$/, '');
  return path.join(root, 'db', 'migrate.mjs');
}

// Run db/migrate.mjs as a child process (§ task 8). Exits non-zero on failure.
function runMigrations(config: Config): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [migrateScriptPath()], {
      env: { ...process.env, DATABASE_URL: config.databaseUrl },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`db/migrate.mjs exited with code ${code}`));
    });
  });
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadConfig(env);
  await runMigrations(config);

  const app = await buildApp({ config });
  await app.listen({ port: config.port, host: config.bindAddress });

  const worker: WorkerHandle = startWorker(pool, config);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    try {
      await worker.stop();
      await app.close();
    } finally {
      await pool.end().catch(() => undefined);
      process.exit(signal === 'SIGTERM' ? 0 : 0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
