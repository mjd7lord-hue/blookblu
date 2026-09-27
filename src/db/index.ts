import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from '../config/env';
import * as schema from './schema';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DB_SSL ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

export const db = drizzle(pool, { schema });
export type DB = typeof db;
export { schema };
