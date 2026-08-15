import { z } from 'zod';

export const RecallTutorialClientSchema = z.enum([
  'codex', 'chatgpt-desktop', 'chatgpt-work', 'chatgpt-web', 'claude-code',
  'claude-desktop', 'claude-cowork', 'cursor', 'cli',
]);
export type RecallTutorialClient = z.infer<typeof RecallTutorialClientSchema>;

export const RecallTutorialCreateSchema = z.object({
  writeClient: RecallTutorialClientSchema,
  recallClient: RecallTutorialClientSchema,
  environment: z.enum(['native', 'wsl']).default('native'),
}).strict();

export const RecallTutorialCheckSchema = z.object({
  reportedFailure: z.enum(['runtime', 'wiring', 'access', 'indexing', 'retrieval']).optional(),
}).strict();

export interface RecallClientCapability {
  id: RecallTutorialClient;
  label: string;
  supported: boolean;
  verification: 'command' | 'guided' | 'unavailable';
  surface: 'mcp' | 'cli';
  limitation?: string;
}

const CLIENTS: Record<RecallTutorialClient, Omit<RecallClientCapability, 'id'>> = {
  codex: { label: 'Codex', supported: true, verification: 'command', surface: 'mcp' },
  'chatgpt-desktop': { label: 'ChatGPT Desktop (Codex)', supported: true, verification: 'guided', surface: 'mcp' },
  'chatgpt-work': { label: 'ChatGPT Work', supported: false, verification: 'unavailable', surface: 'mcp', limitation: 'ChatGPT Work requires a remotely reachable MCP app and workspace approval; localhost cannot be used.' },
  'chatgpt-web': { label: 'ChatGPT web', supported: false, verification: 'unavailable', surface: 'mcp', limitation: 'ChatGPT web cannot connect directly to a localhost Answer Engine and no relay is configured.' },
  'claude-code': { label: 'Claude Code', supported: true, verification: 'command', surface: 'mcp' },
  'claude-desktop': { label: 'Claude Desktop', supported: true, verification: 'guided', surface: 'mcp' },
  'claude-cowork': { label: 'Claude Cowork', supported: false, verification: 'unavailable', surface: 'mcp', limitation: 'Cowork cannot be verified against this localhost integration; remote Cowork cannot reach localhost.' },
  cursor: { label: 'Cursor / JSON MCP adapter', supported: true, verification: 'guided', surface: 'mcp' },
  cli: { label: 'Answer Engine CLI', supported: true, verification: 'guided', surface: 'cli' },
};

export function recallClientCapabilities(environment: 'native' | 'wsl' = 'native'): RecallClientCapability[] {
  return RecallTutorialClientSchema.options.map((id) => {
    const capability = { id, ...CLIENTS[id] };
    if (environment === 'wsl' && (id === 'chatgpt-desktop' || id === 'claude-desktop')) {
      return { ...capability, supported: false, verification: 'unavailable' as const,
        limitation: `${capability.label} runs on the Windows host and cannot use an unbridged WSL2 localhost integration.` };
    }
    return capability;
  });
}
