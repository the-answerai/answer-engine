import type { HttpConnectionResult, WiringInput } from './types.js';

export function renderHttpConnection(input: WiringInput): HttpConnectionResult {
  const url = `${input.serverUrl.replace(/\/+$/, '')}/mcp`;
  const example = {
    mcpServers: {
      'answer-engine': {
        url,
        headers: {
          'X-API-Key': input.apiKey,
        },
      },
    },
  };
  const json = `${JSON.stringify(example, null, 2)}\n`;
  const text = [
    `URL: ${url}`,
    'Headers (choose one):',
    `  X-API-Key: ${input.apiKey}`,
    `  Authorization: Bearer ${input.apiKey}`,
    '',
    'JSON example:',
    json.trimEnd(),
  ].join('\n');

  return { url, text, json };
}
