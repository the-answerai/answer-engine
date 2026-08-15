import {
  detectInstalledClients,
  wireClient,
  type FileWiringClient,
  type WiringResult,
} from '@answer-engine/cli/wiring';
import { parseAgents } from './models.js';
import type { InstallerOptions } from './options.js';
import type { Prompt } from './prompt.js';

export const LOCAL_LIBRARY_ID = '00000000-0000-0000-0000-000000000002';

export async function selectAgents(
  options: InstallerOptions,
  prompt?: Prompt,
): Promise<FileWiringClient[]> {
  if (options.agents !== undefined) return parseAgents(options.agents);
  const detected = detectInstalledClients();
  if (options.yes || !prompt) return detected;
  const defaultValue = detected.length > 0 ? detected.join(',') : 'none';
  const answer = await prompt.input(
    'Agents to wire (comma-separated: claude-code,codex,cursor,claude-desktop; or none)',
    defaultValue,
  );
  return parseAgents(answer);
}

export function wireAgents(
  clients: FileWiringClient[],
  apiKey: string,
  serverUrl = 'http://127.0.0.1:5050',
): WiringResult[] {
  return clients.map((client) => wireClient({
    client,
    apiKey,
    serverUrl,
    library: LOCAL_LIBRARY_ID,
  }));
}
