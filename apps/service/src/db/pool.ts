import { Pool } from 'pg';

// Capped connection pool; DATABASE_URL comes from process.env (see db/migrate.mjs and docker-compose.yml).
export const pool = new Pool({ max: 10, connectionString: process.env.DATABASE_URL });
