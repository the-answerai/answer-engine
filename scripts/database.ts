import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

function integerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function createDatabasePool(): pg.Pool {
  if (process.env.DATABASE_URL) {
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      max: integerEnvironment('DATABASE_POOL_MAX', 5),
      connectionTimeoutMillis: integerEnvironment('DATABASE_CONNECT_TIMEOUT_MS', 10_000),
    });
  }

  return new Pool({
    host: process.env.DATABASE_HOST ?? '127.0.0.1',
    port: integerEnvironment('DATABASE_PORT', 5433),
    database: process.env.DATABASE_NAME ?? 'answerengine',
    user: process.env.DATABASE_USER ?? 'postgres',
    password: process.env.DATABASE_PASSWORD ?? 'postgres',
    max: integerEnvironment('DATABASE_POOL_MAX', 5),
    connectionTimeoutMillis: integerEnvironment('DATABASE_CONNECT_TIMEOUT_MS', 10_000),
  });
}

export function embeddingDimension(): number {
  const dimension = integerEnvironment('EMBEDDING_DIMENSION', 768);
  // pgvector's vector HNSW operator class supports at most 2,000 dimensions.
  if (dimension > 2_000) {
    throw new Error('EMBEDDING_DIMENSION must be between 1 and 2000');
  }
  return dimension;
}
