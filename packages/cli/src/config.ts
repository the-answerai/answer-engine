/**
 * CLI Configuration
 * Resolution order: CLI flags > env vars > config file
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { defaultChannelApiUrl, defaultChannelConfigFile } from './channel.js';

export interface CliConfig {
  api_key: string;
  api_url: string;
  default_output: 'auto' | 'json' | 'table';
}

export const DEFAULT_API_URL = 'http://localhost:5050';

function loadConfigFile(): Partial<CliConfig> {
  const configFile = defaultChannelConfigFile();
  try {
    if (!existsSync(configFile)) return {};
    const content = readFileSync(configFile, 'utf-8');
    const parsed = parseYaml(content) as Partial<CliConfig> | null;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export function saveConfig(updates: Partial<CliConfig>): void {
  const configFile = defaultChannelConfigFile();
  mkdirSync(getConfigDirPath(), { recursive: true });
  const current = loadConfigFile();
  const merged = { ...current, ...updates };
  writeFileSync(configFile, stringifyYaml(merged), { encoding: 'utf-8', mode: 0o600 });
}

export function getConfig(): CliConfig {
  const file = loadConfigFile();
  return {
    api_key: process.env.ANSWER_ENGINE_API_KEY || file.api_key || '',
    api_url: process.env.ANSWER_ENGINE_API_URL || file.api_url || defaultChannelApiUrl(),
    default_output: (file.default_output as CliConfig['default_output']) || 'auto',
  };
}

export function getConfigFilePath(): string {
  return defaultChannelConfigFile();
}

export function getConfigDirPath(): string {
  return dirname(defaultChannelConfigFile());
}

export function maskApiKey(key: string): string {
  if (!key) return '(not set)';
  if (key.length <= 12) return '***';
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}
