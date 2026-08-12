import { createHash, randomBytes } from 'node:crypto';
import { createDatabasePool } from './database.js';

export const LOCAL_TENANT_ID = '00000000-0000-0000-0000-000000000001';
export const LOCAL_LIBRARY_ID = '00000000-0000-0000-0000-000000000002';
export const LOCAL_LIBRARY_SLUG = 'personal-memory';
const LOCAL_KEY_NAME = 'Local installer';

function apiKeyHash(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

function validateApiKey(apiKey: string): string {
  if (!/^ae_live_[A-Za-z0-9_-]{24,}$/.test(apiKey)) {
    throw new Error('ANSWER_ENGINE_API_KEY must be an ae_live_ key with at least 24 secret characters');
  }
  return apiKey;
}

async function main(): Promise<void> {
  const pool = createDatabasePool();
  const client = await pool.connect();
  let keyToReveal: string | undefined;

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, name, slug)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         slug = EXCLUDED.slug`,
      [LOCAL_TENANT_ID, 'Local Answer Engine', 'local'],
    );
    await client.query(
      `INSERT INTO libraries (id, tenant_id, name, slug, description)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, slug) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         is_active = true`,
      [
        LOCAL_LIBRARY_ID,
        LOCAL_TENANT_ID,
        'Personal Memory',
        LOCAL_LIBRARY_SLUG,
        'Local memories available to the installed agents.',
      ],
    );

    const existing = await client.query<{ key_hash: string }>(
      `SELECT key_hash
       FROM api_keys
       WHERE tenant_id = $1 AND name = $2 AND revoked_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [LOCAL_TENANT_ID, LOCAL_KEY_NAME],
    );
    const configuredKey = process.env.ANSWER_ENGINE_API_KEY?.trim();

    if (existing.rows.length === 0) {
      const apiKey = configuredKey
        ? validateApiKey(configuredKey)
        : `ae_live_${randomBytes(32).toString('base64url')}`;
      await client.query(
        `INSERT INTO api_keys (
           tenant_id, key_hash, key_prefix, name
         ) VALUES ($1, $2, $3, $4)`,
        [LOCAL_TENANT_ID, apiKeyHash(apiKey), apiKey.slice(0, 16), LOCAL_KEY_NAME],
      );
      if (!configuredKey) keyToReveal = apiKey;
    } else if (configuredKey && existing.rows[0]?.key_hash !== apiKeyHash(validateApiKey(configuredKey))) {
      throw new Error(
        'ANSWER_ENGINE_API_KEY does not match the existing local installer key; refusing to rotate it implicitly',
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  process.stdout.write(`Local tenant ready (${LOCAL_LIBRARY_SLUG}).\n`);
  // This is the sole intended secret output. The installer captures it once,
  // secures it in .env.compose, and redacts it from all later status output.
  if (keyToReveal) process.stdout.write(`ANSWER_ENGINE_API_KEY=${keyToReveal}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Local bootstrap failed: ${message}\n`);
  process.exitCode = 1;
});
