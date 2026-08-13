import { existsSync } from 'node:fs';
import { createDatabasePool, embeddingDimension } from './database.js';
import {
  downMigrationName,
  migrationDirectory,
  MIGRATION_LOCK,
  readMigration,
  renderMigration,
} from './migration-utils.js';

interface AppliedMigration {
  name: string;
}

function requestedSteps(arguments_: readonly string[]): number {
  const index = arguments_.indexOf('--steps');
  const raw = index >= 0 ? arguments_[index + 1] : '1';
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(value) || value < 1) throw new Error('--steps must be a positive integer');
  return value;
}

async function main(): Promise<void> {
  const steps = requestedSteps(process.argv.slice(2));
  const dimension = embeddingDimension();
  const directory = migrationDirectory(import.meta.url);
  const pool = createDatabasePool();
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    const applied = await client.query<AppliedMigration>(
      `SELECT name FROM schema_migrations
       ORDER BY name DESC
       LIMIT $1`,
      [steps],
    );
    if (applied.rows.length < steps) {
      throw new Error(`Cannot roll back ${steps} migration(s); only ${applied.rows.length} are applied`);
    }

    for (const migration of applied.rows) {
      const downName = downMigrationName(migration.name);
      const downPath = `${directory}/${downName}`;
      if (!existsSync(downPath)) throw new Error(`Missing rollback migration ${downName}`);
      const { template } = await readMigration(directory, downName);
      const sql = renderMigration(template, { EMBEDDING_DIMENSION: String(dimension) });
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('DELETE FROM schema_migrations WHERE name = $1', [migration.name]);
        await client.query('COMMIT');
        process.stdout.write(`Rolled back ${migration.name}\n`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Rollback failed: ${message}\n`);
  process.exitCode = 1;
});
