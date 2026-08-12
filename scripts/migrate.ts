import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabasePool, embeddingDimension } from './database.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sourceMigrationDirectory = join(
  scriptDirectory,
  '..',
  'database',
  'migrations',
);
const builtMigrationDirectory = join(
  scriptDirectory,
  '..',
  '..',
  'database',
  'migrations',
);
const migrationDirectory = existsSync(sourceMigrationDirectory)
  ? sourceMigrationDirectory
  : builtMigrationDirectory;
const migrationLock = 1_104_202_026;

interface AppliedMigration {
  name: string;
  checksum: string;
}

async function main(): Promise<void> {
  const dimension = embeddingDimension();
  const pool = createDatabasePool();
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [migrationLock]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const appliedResult = await client.query<AppliedMigration>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const applied = new Map(appliedResult.rows.map((row) => [row.name, row.checksum]));
    const files = (await readdir(migrationDirectory))
      .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
      .sort();

    for (const name of files) {
      const template = await readFile(join(migrationDirectory, name), 'utf8');
      const checksum = createHash('sha256').update(template).digest('hex');
      const existingChecksum = applied.get(name);
      if (existingChecksum) {
        if (existingChecksum !== checksum) {
          throw new Error(`Applied migration ${name} has been modified`);
        }
        continue;
      }

      const sql = template.replaceAll('{{EMBEDDING_DIMENSION}}', String(dimension));
      if (sql.includes('{{')) throw new Error(`Unresolved template token in ${name}`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [name, checksum],
        );
        await client.query('COMMIT');
        process.stdout.write(`Applied ${name}\n`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    const dimensionResult = await client.query<{ value: string }>(
      "SELECT value FROM schema_settings WHERE key = 'embedding_dimension'",
    );
    const installedDimension = Number.parseInt(dimensionResult.rows[0]?.value ?? '', 10);
    if (installedDimension !== dimension) {
      throw new Error(
        `Database embedding dimension is ${installedDimension}; requested ${dimension}. `
        + 'Changing it requires a fresh database and re-embedding.',
      );
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [migrationLock]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Migration failed: ${message}\n`);
  process.exitCode = 1;
});
