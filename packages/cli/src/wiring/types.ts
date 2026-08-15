export const FILE_WIRING_CLIENTS = [
  'claude-code',
  'codex',
  'cursor',
  'claude-desktop',
] as const;

export type FileWiringClient = typeof FILE_WIRING_CLIENTS[number];
export type WiringClient = FileWiringClient | 'http';

export interface WiringInput {
  client: WiringClient;
  apiKey: string;
  serverUrl: string;
  library?: string;
  mcpEntry?: McpStdioEntry;
}

export type FileWiringInput = WiringInput & { client: FileWiringClient };

export interface WiringResult {
  path: string;
  backupPath?: string;
  created: boolean;
}

export interface McpStdioEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface HttpConnectionResult {
  url: string;
  text: string;
  json: string;
}
