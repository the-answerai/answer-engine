import type { McpStdioEntry, WiringInput } from './types.js';

export function buildMcpEntry(input: WiringInput): McpStdioEntry {
  if (input.mcpEntry) return input.mcpEntry;
  throw new Error('A verified Answer Engine MCP launcher is required for client wiring.');
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
  const launcher = [entry.command, ...entry.args].map(shellToken).join(' ');
  return `claude mcp add answer-engine${envArgs ? ` ${envArgs}` : ''} -- ${launcher}`;
}
