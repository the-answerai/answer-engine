declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
      apiKeyId?: string;
      libraryId?: string;
      apiCapabilities?: readonly ('read' | 'write')[];
      apiSurface?: 'mcp' | 'cli' | 'cli-sync' | 'browser' | 'api';
      apiClient?: 'codex' | 'chatgpt-desktop' | 'claude-code' | 'claude-desktop' | 'cursor' | 'cli';
    }
  }
}
export {};
