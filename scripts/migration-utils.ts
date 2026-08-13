import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const upPattern = /^\d{3}_[a-z0-9_]+\.sql$/;
const downPattern = /^\d{3}_[a-z0-9_]+\.down\.sql$/;

export function isUpMigration(name: string): boolean {
  return upPattern.test(name);
}

export function isDownMigration(name: string): boolean {
  return downPattern.test(name);
}

export function migrationVersion(name: string): number {
  if (!isUpMigration(name) && !isDownMigration(name)) {
    throw new Error(`Invalid migration name: ${name}`);
  }
  return Number.parseInt(name.slice(0, 3), 10);
}

export function downMigrationName(upName: string): string {
  if (!isUpMigration(upName)) throw new Error(`Invalid up migration name: ${upName}`);
  return upName.replace(/\.sql$/, '.down.sql');
}

export function migrationDirectory(importMetaUrl: string): string {
  const scriptDirectory = dirname(fileURLToPath(importMetaUrl));
  const source = join(scriptDirectory, '..', 'database', 'migrations');
  const built = join(scriptDirectory, '..', '..', 'database', 'migrations');
  return existsSync(source) ? source : built;
}

export async function listUpMigrations(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter(isUpMigration).sort();
}

export async function readMigration(directory: string, name: string): Promise<{
  readonly checksum: string;
  readonly template: string;
}> {
  const template = await readFile(join(directory, name), 'utf8');
  return {
    checksum: createHash('sha256').update(template).digest('hex'),
    template,
  };
}

export function renderMigration(template: string, values: Readonly<Record<string, string>>): string {
  let sql = template;
  for (const [key, value] of Object.entries(values)) {
    sql = sql.replaceAll(`{{${key}}}`, value);
  }
  if (sql.includes('{{')) throw new Error('Unresolved migration template token');
  return sql;
}

export const MIGRATION_LOCK = 1_104_202_026;
