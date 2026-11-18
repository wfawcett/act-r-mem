import type { PoolClient } from 'pg';
import { pool } from './pool.js';

// Runs fn inside a transaction scoped to tenantId: pulls one client from the pool,
// begins a transaction, sets the local GUC app.tenant_id (only visible within this
// transaction), awaits fn, then commits. On error it rolls back and rethrows; the
// client is always released so the pool stays clean.
export async function withTenant<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
