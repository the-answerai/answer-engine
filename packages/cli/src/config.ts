/**
 * CLI Configuration
 * Resolution order: CLI flags > env vars > config file
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface CliConfig {
  api_key: string;
  api_url: string;
  default_output: 'auto' | 'json' | 'table';
}

const CONFIG_DIR = join(homedir(), '.config', 'answer-engine');
const CONFIG_FILE = join(CONFIG_DIR, 'config.yml');

export const DEFAULT_API_URL = 'http://localhost:5050';

const DEFAULTS: CliConfig = {
  api_key: '',
  api_url: DEFAULT_API_URL,
  default_output: 'auto',
};

function loadConfigFile(): Partial<CliConfig> {
  try {
    if (!existsSync(CONFIG_FILE)) return {};
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    const parsed = parseYaml(content) as Partial<CliConfig> | null;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export function saveConfig(updates: Partial<CliConfig>): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const current = loadConfigFile();
  const merged = { ...current, ...updates };
  writeFileSync(CONFIG_FILE, stringifyYaml(merged), { encoding: 'utf-8', mode: 0o600 });
}

export function getConfig(): CliConfig {
  const file = loadConfigFile();
  return {
    api_key: process.env.ANSWER_ENGINE_API_KEY || file.api_key || DEFAULTS.api_key,
    api_url: process.env.ANSWER_ENGINE_API_URL || file.api_url || DEFAULTS.api_url,
    default_output: (file.default_output as CliConfig['default_output']) || DEFAULTS.default_output,
  };
}

export function getConfigFilePath(): string {
  return CONFIG_FILE;
}

export function getConfigDirPath(): string {
  return CONFIG_DIR;
}

export function maskApiKey(key: string): string {
  if (!key) return '(not set)';
  if (key.length <= 12) return '***';
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}
