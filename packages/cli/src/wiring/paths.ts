import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { FILE_WIRING_CLIENTS } from './types.js';
import type { FileWiringClient } from './types.js';

export interface WiringPathOptions {
  homeDir?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  appData?: string;
  cursorScope?: 'auto' | 'project' | 'global';
}

export interface ClientDetectionOptions extends WiringPathOptions {
  forceAll?: boolean;
}

function cursorConfigPath(options: WiringPathOptions): string {
  const homeDir = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const scope = options.cursorScope ?? 'auto';
  const projectDir = join(cwd, '.cursor');
  if (scope === 'project' || (scope === 'auto' && existsSync(projectDir))) {
    return join(projectDir, 'mcp.json');
  }
  return join(homeDir, '.cursor', 'mcp.json');
}

export function resolveClientConfigPath(
  client: FileWiringClient,
  options: WiringPathOptions = {},
): string {
  const homeDir = options.homeDir ?? homedir();
  switch (client) {
    case 'claude-code':
      return join(homeDir, '.claude.json');
    case 'codex':
      return join(homeDir, '.codex', 'config.toml');
    case 'cursor':
      return cursorConfigPath(options);
    case 'claude-desktop': {
      const platform = options.platform ?? process.platform;
      if (platform === 'darwin') {
        return join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      }
      if (platform === 'win32') {
        const appData = options.appData ?? process.env.APPDATA ?? join(homeDir, 'AppData', 'Roaming');
        return join(appData, 'Claude', 'claude_desktop_config.json');
      }
      return join(homeDir, '.config', 'Claude', 'claude_desktop_config.json');
    }
  }
}

function clientLooksInstalled(client: FileWiringClient, options: WiringPathOptions): boolean {
  const path = resolveClientConfigPath(client, options);
  if (existsSync(path)) return true;
  switch (client) {
    case 'claude-code':
      return existsSync(join(options.homeDir ?? homedir(), '.claude'));
    case 'codex':
    case 'cursor':
    case 'claude-desktop':
      return existsSync(dirname(path));
  }
}

export function detectInstalledClients(options: ClientDetectionOptions = {}): FileWiringClient[] {
  if (options.forceAll) return [...FILE_WIRING_CLIENTS];
  return FILE_WIRING_CLIENTS.filter((client) => clientLooksInstalled(client, options));
}
