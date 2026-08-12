import pg from 'pg';
import { env } from './env.js';

const { Pool } = pg;

export const pool = new Pool({
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  database: env.DATABASE_NAME,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
  max: env.DATABASE_POOL_MAX,
});

export type Database = Pick<pg.Pool, 'query' | 'connect'>;

export async function testDatabaseConnection(): Promise<void> {
  await pool.query('SELECT 1');
}

export async function closeDatabasePool(): Promise<void> {
  await pool.end();
}
