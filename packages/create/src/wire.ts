import {
  detectInstalledClients,
  wireClient,
  type FileWiringClient,
  type WiringResult,
} from '@answer-engine/cli/wiring';
import { parseAgents } from './models.js';
import type { InstallerOptions } from './options.js';
import type { Prompt } from './prompt.js';
import {
  CLIENT_IDS,
  defaultNonInteractiveClients,
  detectAgentClients,
  parseClientSelection,
  type AgentClientId,
} from './clients.js';

export const LOCAL_LIBRARY_ID = '00000000-0000-0000-0000-000000000002';

export async function selectClients(
  options: InstallerOptions,
  prompt?: Prompt,
): Promise<AgentClientId[]> {
  if (options.clients !== undefined && options.agents !== undefined) {
    const clients = parseClientSelection(options.clients);
    const agents = parseClientSelection(options.agents);
    if (clients.join(',') !== agents.join(',')) {
      throw new Error('--clients and its legacy --agents alias cannot select different clients.');
    }
    return clients;
  }
  const explicit = options.clients ?? options.agents;
  if (explicit !== undefined) return parseClientSelection(explicit);
  const detected = detectAgentClients({
    coworkMode: options.coworkMode === 'local' || options.coworkMode === 'remote'
      ? options.coworkMode
      : 'unknown',
  });
  if (options.yes || !prompt) return defaultNonInteractiveClients(detected);
  const detectedIds = detected.map((client) => client.id);
  const defaultValue = detectedIds.length > 0 ? detectedIds.join(',') : 'none';
  const answer = await prompt.input(
    `Clients to connect (comma-separated: ${CLIENT_IDS.join(',')}; or none)`,
    defaultValue,
  );
  return parseClientSelection(answer);
}

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
