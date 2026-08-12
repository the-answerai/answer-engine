import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Database } from '../config/database.js';
import { AuthenticationError } from '../utils/errors.js';
import { hasValidLocalUiSession } from './local-ui-session.js';

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  library_id: string | null;
  key_hash: string;
}

export interface ApiKeyAuthOptions {
  readonly localUiApiKey?: string;
}

function extractApiKey(headers: Record<string, string | string[] | undefined>): string | undefined {
  const header = headers['x-api-key'];
  const direct = Array.isArray(header) ? header[0] : header;
  if (direct?.trim()) return direct.trim();
  const authorization = headers.authorization;
  const bearer = Array.isArray(authorization) ? authorization[0] : authorization;
  return bearer?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
}

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

export function createApiKeyAuth(database: Database, options: ApiKeyAuthOptions = {}): RequestHandler {
  return async (req, _res, next) => {
    try {
      const headerApiKey = extractApiKey(req.headers);
      const apiKey = headerApiKey ?? (
        options.localUiApiKey && hasValidLocalUiSession(req, options.localUiApiKey)
          ? options.localUiApiKey
          : undefined
      );
      if (!apiKey) throw new AuthenticationError();
      if (!apiKey.startsWith('ae_live_')) {
        throw new AuthenticationError('The API key is invalid or expired');
      }
      const hash = hashApiKey(apiKey);
      const result = await database.query<ApiKeyRow>(
        `SELECT id, tenant_id, library_id, key_hash
           FROM api_keys
          WHERE key_hash = $1
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > NOW())`,
        [hash],
      );
      const key = result.rows[0];
      if (!key) throw new AuthenticationError('The API key is invalid or expired');
      const actual = Buffer.from(key.key_hash, 'hex');
      const expected = Buffer.from(hash, 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new AuthenticationError('The API key is invalid or expired');
      }
      req.tenantId = key.tenant_id;
      req.apiKeyId = key.id;
      req.libraryId = key.library_id ?? undefined;
      await database.query(
        'UPDATE api_keys SET last_used_at = NOW() WHERE tenant_id = $1 AND id = $2',
        [key.tenant_id, key.id],
      );
      next();
    } catch (error) {
      next(error);
    }
  };
}
