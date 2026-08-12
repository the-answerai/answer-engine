import type { McpStdioEntry, WiringInput } from './types.js';

export const MCP_SERVER_PACKAGE = '@answer-engine/mcp-server@1.1.0';

export function buildMcpEntry(input: WiringInput): McpStdioEntry {
  const env: Record<string, string> = {
    ANSWER_ENGINE_API_KEY: input.apiKey,
    ANSWER_ENGINE_API_URL: input.serverUrl,
  };
  if (input.library) env.ANSWER_ENGINE_LIBRARY = input.library;

  return {
    command: 'npx',
    args: ['-y', MCP_SERVER_PACKAGE],
    env,
  };
}

function shellToken(value: string): string {
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderClaudeCodeCommand(input: WiringInput): string {
  const entry = buildMcpEntry(input);
  const envArgs = Object.entries(entry.env)
    .map(([key, value]) => `--env ${shellToken(`${key}=${value}`)}`)
    .join(' ');
  return `claude mcp add answer-engine ${envArgs} -- npx -y ${MCP_SERVER_PACKAGE}`;
}
