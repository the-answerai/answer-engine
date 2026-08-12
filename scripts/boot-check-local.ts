import { createDatabasePool } from './database.js';

const LOCAL_TENANT_ID = '00000000-0000-0000-0000-000000000001';
const LOCAL_LIBRARY_ID = '00000000-0000-0000-0000-000000000002';

async function main(): Promise<void> {
  const pool = createDatabasePool();
  try {
    const result = await pool.query<{
      tenants: number;
      libraries: number;
      api_keys: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM tenants WHERE id = $1) AS tenants,
         (SELECT COUNT(*)::int FROM libraries WHERE tenant_id = $1 AND id = $2) AS libraries,
         (SELECT COUNT(*)::int FROM api_keys
          WHERE tenant_id = $1 AND revoked_at IS NULL) AS api_keys`,
      [LOCAL_TENANT_ID, LOCAL_LIBRARY_ID],
    );
    const counts = result.rows[0];
    if (!counts || counts.tenants !== 1 || counts.libraries !== 1 || counts.api_keys < 1) {
      throw new Error(`Incomplete local bootstrap: ${JSON.stringify(counts)}`);
    }
    process.stdout.write('Local database bootstrap verified.\n');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Boot check failed: ${message}\n`);
  process.exitCode = 1;
});
