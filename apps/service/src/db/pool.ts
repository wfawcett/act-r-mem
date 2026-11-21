import { Pool } from 'pg';

// Capped connection pool. Created lazily on first use, not at import time:
// ESM hoists static imports above the `process.env.DATABASE_URL = ...`
// assignment in several test files, so an import-time Pool captured an empty
// connectionString depending on import order (observed as cross-file suite
// failures that never reproduced when a file ran alone).
let poolInstance: Pool | undefined;

export function getPool(): Pool {
  if (!poolInstance) {
    poolInstance = new Pool({ max: 10, connectionString: process.env.DATABASE_URL });
  }
  return poolInstance;
}

// Compatibility export: `import { pool } from './pool.js'` keeps working —
// every property access forwards to the lazily created Pool instance.
export const pool = new Proxy({} as Pool, {
  get(_target, prop) {
    const real = getPool() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
});
