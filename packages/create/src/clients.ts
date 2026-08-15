import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { z } from 'zod';

export const CLIENT_IDS = [
  'codex',
  'chatgpt-desktop',
  'chatgpt-work',
  'chatgpt-web',
  'claude-code',
  'claude-desktop',
  'claude-cowork',
  'cursor',
] as const;

export const AgentClientIdSchema = z.enum(CLIENT_IDS);
export type AgentClientId = z.infer<typeof AgentClientIdSchema>;
export const CoworkModeSchema = z.enum(['unknown', 'local', 'remote']);
export type CoworkMode = z.infer<typeof CoworkModeSchema>;

export const ClientCapabilitySchema = z.object({
  id: AgentClientIdSchema,
  label: z.string().min(1),
  surface: z.enum(CLIENT_IDS),
  execution: z.enum(['local', 'remote', 'unknown']),
  localhost: z.boolean(),
  packaging: z.enum(['plugin', 'skills', 'mcp-config', 'none']),
  access: z.enum(['stdio-mcp', 'remote-mcp', 'cli', 'none']),
  verification: z.enum(['command', 'guided', 'unavailable']),
  supported: z.boolean(),
  limitation: z.string().min(1).optional(),
  detected: z.boolean().default(false),
}).strict();
export type ClientCapability = z.infer<typeof ClientCapabilitySchema>;

const BASE_CAPABILITIES: Record<AgentClientId, Omit<ClientCapability, 'detected'>> = {
  codex: {
    id: 'codex', label: 'Codex', surface: 'codex', execution: 'local', localhost: true,
    packaging: 'plugin', access: 'stdio-mcp', verification: 'command', supported: true,
  },
  'chatgpt-desktop': {
    id: 'chatgpt-desktop', label: 'ChatGPT Desktop (Codex)', surface: 'chatgpt-desktop',
    execution: 'local', localhost: true, packaging: 'plugin', access: 'stdio-mcp',
    verification: 'guided', supported: true,
    limitation: 'Restart the ChatGPT desktop Codex host, install Answer Engine from the Personal plugin marketplace, and complete the guided recall check.',
  },
  'chatgpt-work': {
    id: 'chatgpt-work', label: 'ChatGPT Work', surface: 'chatgpt-work', execution: 'remote',
    localhost: false, packaging: 'none', access: 'remote-mcp', verification: 'unavailable',
    supported: false,
    limitation: 'ChatGPT Work requires a remotely reachable MCP app and workspace policy approval; this installer does not operate a relay.',
  },
  'chatgpt-web': {
    id: 'chatgpt-web', label: 'ChatGPT web', surface: 'chatgpt-web', execution: 'remote',
    localhost: false, packaging: 'none', access: 'remote-mcp', verification: 'unavailable',
    supported: false,
    limitation: 'ChatGPT web requires remote MCP and cannot connect directly to localhost; this installer does not operate a relay.',
  },
  'claude-code': {
    id: 'claude-code', label: 'Claude Code', surface: 'claude-code', execution: 'local',
    localhost: true, packaging: 'plugin', access: 'stdio-mcp', verification: 'command',
    supported: true,
  },
  'claude-desktop': {
    id: 'claude-desktop', label: 'Claude Desktop', surface: 'claude-desktop', execution: 'local',
    localhost: true, packaging: 'mcp-config', access: 'stdio-mcp', verification: 'guided',
    supported: true,
    limitation: 'Claude Desktop must be restarted before a guided recall check can confirm the local MCP connection.',
  },
  'claude-cowork': {
    id: 'claude-cowork', label: 'Claude Cowork', surface: 'claude-cowork', execution: 'unknown',
    localhost: false, packaging: 'none', access: 'none', verification: 'unavailable',
    supported: false,
    limitation: 'Choose local or remote Cowork mode. Remote sessions cannot reach localhost; local sessions also depend on desktop plugin policy.',
  },
  cursor: {
    id: 'cursor', label: 'Cursor / JSON MCP adapter', surface: 'cursor', execution: 'local',
    localhost: true, packaging: 'mcp-config', access: 'stdio-mcp', verification: 'guided',
    supported: true,
    limitation: 'Restart the client and complete the guided recall check after its JSON MCP adapter reloads.',
  },
};

export function capabilityForClient(
  id: AgentClientId,
  coworkMode: CoworkMode = 'unknown',
): ClientCapability {
  if (id !== 'claude-cowork' || coworkMode === 'unknown') {
    return ClientCapabilitySchema.parse({ ...BASE_CAPABILITIES[id], detected: false });
  }
  if (coworkMode === 'remote') {
    return ClientCapabilitySchema.parse({
      ...BASE_CAPABILITIES[id],
      execution: 'remote',
      access: 'remote-mcp',
      limitation: 'Remote Cowork sessions cannot reach localhost. A public remote MCP relay is out of scope.',
      detected: false,
    });
  }
  return ClientCapabilitySchema.parse({
    ...BASE_CAPABILITIES[id],
    execution: 'local',
    localhost: true,
    limitation: 'Local Cowork can use account-synced skills and policy-approved connectors, but this installer cannot install or verify a localhost plugin in Cowork.',
    detected: false,
  });
}

export interface ClientDetectionOptions {
  homeDir?: string;
  platform?: NodeJS.Platform;
  coworkMode?: CoworkMode;
  commandExists?: (command: string) => boolean;
  applicationExists?: (application: string) => boolean;
}

function executableOnPath(command: string): boolean {
  return (process.env.PATH ?? '').split(delimiter)
    .some((directory) => existsSync(join(directory, command)));
}

export function detectAgentClients(options: ClientDetectionOptions = {}): ClientCapability[] {
  const homeDir = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const commandExists = options.commandExists ?? executableOnPath;
  const applicationExists = options.applicationExists
    ?? ((application: string) => platform === 'darwin' && existsSync(join('/Applications', application)));
  const claudeApp = applicationExists('Claude.app')
    || existsSync(join(homeDir, 'Library', 'Application Support', 'Claude'));
  const detected = new Set<AgentClientId>();
  if (commandExists('codex') || existsSync(join(homeDir, '.codex'))) detected.add('codex');
  if (applicationExists('ChatGPT.app')) detected.add('chatgpt-desktop');
  if (commandExists('claude') || existsSync(join(homeDir, '.claude'))) detected.add('claude-code');
  if (claudeApp) {
    detected.add('claude-desktop');
    detected.add('claude-cowork');
  }
  if (existsSync(join(homeDir, '.cursor'))) detected.add('cursor');
  return CLIENT_IDS
    .filter((id) => detected.has(id))
    .map((id) => ClientCapabilitySchema.parse({
      ...capabilityForClient(id, options.coworkMode),
      detected: true,
    }));
}

export function parseClientSelection(value: string): AgentClientId[] {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none' || normalized.length === 0) return [];
  const clients: AgentClientId[] = [];
  for (const raw of normalized.split(',')) {
    const parsed = AgentClientIdSchema.safeParse(raw.trim());
    if (!parsed.success) {
      throw new Error(`Unknown client "${raw.trim()}"; choose ${CLIENT_IDS.join(', ')}, or none.`);
    }
    if (!clients.includes(parsed.data)) clients.push(parsed.data);
  }
  return clients;
}

export function defaultNonInteractiveClients(
  detected: readonly ClientCapability[],
): AgentClientId[] {
  return detected
    .filter((client) => client.supported && client.verification === 'command')
    .map((client) => client.id);
}
