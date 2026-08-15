import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';
import {
  UserConfigSchema,
  type UserConfig,
} from '@answer-engine/cli/scaffold';
import type { ModelRuntime } from './models.js';
import { createRuntimeChannelProfile, writeRuntimeOwnershipMarker, type RuntimeChannelProfile } from './runtime-channel.js';

const templateDirectory = fileURLToPath(new URL('../templates/', import.meta.url));

export interface ScaffoldInput {
  home: string;
  config: UserConfig;
  runtime?: ModelRuntime;
  profile?: RuntimeChannelProfile;
}

export interface ScaffoldResult {
  home: string;
  configPath: string;
  composePath: string;
  envPath: string;
  apiKey?: string;
}

export interface ScaffoldDependencies {
  generateSecret?: (name: 'key' | 'salt' | 'database') => string;
  templatesDir?: string;
}

function readOptional(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
    throw error;
  }
}

function decodeEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === 'string' ? parsed : trimmed;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export function readEnvValue(contents: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...contents.matchAll(new RegExp(`^\\s*${escaped}\\s*=\\s*(.*)$`, 'gm'))];
  const value = matches.at(-1)?.[1];
  return value === undefined ? undefined : decodeEnvValue(value);
}

function envValue(value: string | number): string {
  const text = String(value);
  return /^[A-Za-z0-9_./:@+-]+$/.test(text) ? text : JSON.stringify(text);
}

function envLine(key: string, value: string | undefined): string {
  return value ? `${key}=${envValue(value)}` : '';
}

function replacements(
  config: UserConfig,
  runtime: ModelRuntime,
  encryptionKey: string,
  encryptionSalt: string,
  apiKey: string | undefined,
  databasePassword: string,
  profile: RuntimeChannelProfile,
): Record<string, string> {
  const localChat = config.models.chat_provider === 'lmstudio';
  const localEmbedding = config.models.embedding_provider === 'lmstudio';
  const openAiKey = config.connectors.openai_api_key;
  return {
    COMPOSE_PROJECT: envValue(profile.composeProject),
    CHANNEL: envValue(profile.channel),
    API_PORT: String(profile.ports.api),
    DATABASE_HOST_PORT: String(profile.ports.database),
    REDIS_HOST_PORT: String(profile.ports.redis),
    WEB_PORT: String(profile.ports.web),
    MCP_PORT: String(profile.ports.mcp),
    DATABASE_NAME: envValue(profile.databaseName),
    DATABASE_PASSWORD: envValue(databasePassword),
    POSTGRES_VOLUME: envValue(profile.volumes.postgres),
    REDIS_VOLUME: envValue(profile.volumes.redis),
    BLOBS_VOLUME: envValue(profile.volumes.blobs),
    HISTORY_SYNC_ENABLED: String(profile.sync.enabledByDefault),
    CHAT_PROVIDER: envValue(config.models.chat_provider),
    CHAT_MODEL: envValue(config.models.chat),
    EMBEDDING_PROVIDER: envValue(config.models.embedding_provider),
    EMBEDDING_MODEL: envValue(config.models.embedding),
    EMBEDDING_DIMENSION: String(config.models.embedding_dimension),
    LLM_BASE_URL_LINE: localChat
      ? envLine(
        'LLM_BASE_URL',
        runtime.llmBaseUrl ?? 'http://host.docker.internal:1234/v1',
      )
      : '',
    EMBEDDING_BASE_URL_LINE: localEmbedding
      ? envLine(
        'EMBEDDING_BASE_URL',
        runtime.embeddingBaseUrl ?? 'http://host.docker.internal:1234/v1',
      )
      : '',
    ANTHROPIC_API_KEY_LINE: envLine(
      'ANTHROPIC_API_KEY',
      config.connectors.anthropic_api_key,
    ),
    OPENAI_API_KEY_LINE: envLine('OPENAI_API_KEY', openAiKey),
    LLM_API_KEY_LINE: config.models.chat_provider === 'openai'
      ? envLine('LLM_API_KEY', openAiKey)
      : '',
    EMBEDDING_API_KEY_LINE: config.models.embedding_provider === 'openai'
      ? envLine('EMBEDDING_API_KEY', openAiKey)
      : '',
    ENCRYPTION_KEY: envValue(encryptionKey),
    ENCRYPTION_SALT: envValue(encryptionSalt),
    ANSWER_ENGINE_API_KEY_LINE: envLine('ANSWER_ENGINE_API_KEY', apiKey),
  };
}

function renderTemplate(template: string, values: Record<string, string>): string {
  const rendered = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key: string) => {
    if (!(key in values)) throw new Error(`Missing installer template value ${key}.`);
    return values[key];
  });
  return `${rendered.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

export function scaffoldInstallation(
  input: ScaffoldInput,
  dependencies: ScaffoldDependencies = {},
): ScaffoldResult {
  const config = UserConfigSchema.parse(input.config);
  const profile = input.profile ?? createRuntimeChannelProfile('stable', { home: input.home });
  const templatesDir = dependencies.templatesDir ?? templateDirectory;
  const generateSecret = dependencies.generateSecret
    ?? (() => randomBytes(32).toString('hex'));
  const configPath = join(input.home, 'config.yaml');
  const composePath = join(input.home, 'docker-compose.yml');
  const envPath = join(input.home, '.env.compose');
  const existingEnv = readOptional(envPath);
  const encryptionKey = readEnvValue(existingEnv, 'ENCRYPTION_KEY')
    ?? generateSecret('key');
  const encryptionSalt = readEnvValue(existingEnv, 'ENCRYPTION_SALT')
    ?? generateSecret('salt');
  const apiKey = readEnvValue(existingEnv, 'ANSWER_ENGINE_API_KEY');
  const databasePassword = readEnvValue(existingEnv, 'DATABASE_PASSWORD')
    ?? generateSecret('database');

  mkdirSync(join(input.home, 'data', 'postgres'), { recursive: true });
  mkdirSync(join(input.home, 'data', 'redis'), { recursive: true });
  mkdirSync(join(input.home, 'blobs'), { recursive: true });
  mkdirSync(join(input.home, 'raw-archive'), { recursive: true });
  mkdirSync(join(input.home, 'logs'), { recursive: true });

  writeFileSync(configPath, stringifyYaml(config), { encoding: 'utf8', mode: 0o600 });
  chmodSync(configPath, 0o600);
  writeFileSync(
    composePath,
    renderTemplate(
      readFileSync(join(templatesDir, 'docker-compose.yml'), 'utf8'),
      replacements(
        config,
        input.runtime ?? {},
        encryptionKey,
        encryptionSalt,
        apiKey,
        databasePassword,
        profile,
      ),
    ),
    'utf8',
  );
  const environment = renderTemplate(
    readFileSync(join(templatesDir, 'env.compose.tmpl'), 'utf8'),
    replacements(
      config,
      input.runtime ?? {},
      encryptionKey,
      encryptionSalt,
      apiKey,
      databasePassword,
      profile,
    ),
  );
  writeFileSync(envPath, environment, { encoding: 'utf8', mode: 0o600 });
  chmodSync(envPath, 0o600);
  writeRuntimeOwnershipMarker(profile);

  return {
    home: input.home,
    configPath,
    composePath,
    envPath,
    ...(apiKey ? { apiKey } : {}),
  };
}
