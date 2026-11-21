import type { Pool } from 'pg';

// FR-24: forget/restore flip `invalid_at` on the node and on its incident edges.
// The HTTP routes are E10; only the DB side ships here.

export async function forgetNode(pool: Pool, id: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE nodes SET invalid_at = now() WHERE id = $1`, [id]);
    await client.query(
      `UPDATE edges SET invalid_at = now() WHERE (src = $1 OR dst = $1) AND invalid_at IS NULL`,
      [id],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function restoreNode(pool: Pool, id: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE nodes SET invalid_at = NULL WHERE id = $1`, [id]);
    await client.query(`UPDATE edges SET invalid_at = NULL WHERE (src = $1 OR dst = $1)`, [id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
