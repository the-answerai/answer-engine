import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { envFilePath, ensureAeHomeLayout, resolveAeHome } from './home.js';
import type { UserConfig } from './user-config.js';

const MANAGED_KEYS = [
  'AUTH_MODE',
  'STORAGE_DRIVER',
  'AE_HOME',
  'LLM_PROVIDER',
  'MODELS_CHAT',
  'EMBEDDING_PROVIDER',
  'MODELS_EMBEDDING',
  'EMBEDDING_DIMENSION',
  'PORT',
  'HOST',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'LLM_API_KEY',
  'EMBEDDING_API_KEY',
] as const;

const managedKeyPattern = new RegExp(`^\\s*(?:${MANAGED_KEYS.join('|')})\\s*=`);

function serializeEnvValue(value: string | number): string {
  const stringValue = String(value);
  return /^[A-Za-z0-9_./:@+-]+$/.test(stringValue)
    ? stringValue
    : JSON.stringify(stringValue);
}

function assignment(key: string, value: string | number): string {
  return `${key}=${serializeEnvValue(value)}`;
}

export function renderEnvFromConfig(config: UserConfig): string {
  const lines = [
    assignment('AUTH_MODE', 'api_key'),
    assignment('STORAGE_DRIVER', 'local'),
    assignment('AE_HOME', resolveAeHome()),
    assignment('LLM_PROVIDER', config.models.chat_provider),
    assignment('MODELS_CHAT', config.models.chat),
    assignment('EMBEDDING_PROVIDER', config.models.embedding_provider),
    assignment('MODELS_EMBEDDING', config.models.embedding),
    assignment('EMBEDDING_DIMENSION', config.models.embedding_dimension),
    assignment('PORT', config.server.port),
    assignment('HOST', config.server.bind),
  ];

  const connectors = config.connectors;
  if (connectors.anthropic_api_key) {
    lines.push(assignment('ANTHROPIC_API_KEY', connectors.anthropic_api_key));
  }
  if (connectors.openai_api_key) {
    lines.push(assignment('OPENAI_API_KEY', connectors.openai_api_key));
    if (config.models.chat_provider === 'openai') {
      lines.push(assignment('LLM_API_KEY', connectors.openai_api_key));
    }
    if (config.models.embedding_provider === 'openai') {
      lines.push(assignment('EMBEDDING_API_KEY', connectors.openai_api_key));
    }
  }

  return `${lines.join('\n')}\n`;
}

export function mergeGeneratedEnv(existing: string, generated: string): string {
  const preserved = existing
    .split(/\r?\n/)
    .filter((line) => !managedKeyPattern.test(line));
  while (preserved.at(-1) === '') preserved.pop();

  const sections = [preserved.join('\n'), generated.trimEnd()].filter(Boolean);
  return `${sections.join('\n\n')}\n`;
}

export function writeEnvFile(config: UserConfig, path: string = envFilePath()): void {
  ensureAeHomeLayout();
  mkdirSync(dirname(path), { recursive: true });

  let existing = '';
  try {
    existing = readFileSync(path, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }

  writeFileSync(path, mergeGeneratedEnv(existing, renderEnvFromConfig(config)), {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}
