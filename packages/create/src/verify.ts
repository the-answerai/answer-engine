import { randomUUID } from 'node:crypto';
import {
  capabilityForClient,
  type AgentClientId,
  type CoworkMode,
} from './clients.js';
import type { CommandRunner } from './process.js';
import { runCommand as defaultRunCommand } from './process.js';
import type { Prompt } from './prompt.js';

const LOCAL_LIBRARY_ID = '00000000-0000-0000-0000-000000000002';
const VERIFY_SOURCE = 'create-installer';

export interface VerifyOptions {
  apiKey: string;
  apiUrl?: string;
  marker?: string;
  fetchImpl?: typeof fetch;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Verification received an invalid ${label} response.`);
  }
  return value as Record<string, unknown>;
}

async function request(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
      // The import route reserves synchronous storage for agent memory
      // surfaces. This makes the verification deterministic and mirrors the
      // MCP remember tool used after wiring.
      'X-AE-Surface': 'mcp',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = record(await response.json(), 'API');
  if (!response.ok) {
    const error = typeof payload.error === 'object' && payload.error !== null
      ? payload.error as Record<string, unknown>
      : {};
    throw new Error(
      `Verification request failed (${response.status}): ${String(error.message ?? 'unknown error')}`,
    );
  }
  return payload;
}

export async function verifyMemoryRoundTrip(options: VerifyOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiUrl = (options.apiUrl ?? 'http://localhost:5050').replace(/\/+$/, '');
  const marker = options.marker ?? `aecreate${randomUUID().replaceAll('-', '')}`;
  const sourceIdentifier = `${VERIFY_SOURCE}:${marker}`;
  const remembered = await request(
    fetchImpl,
    `${apiUrl}/api/v1/content/import`,
    options.apiKey,
    'POST',
    {
      libraryId: LOCAL_LIBRARY_ID,
      options: { forceStore: true },
      items: [{
        title: `Answer Engine installer verification ${marker}`,
        content_type: 'chat',
        content: `One-command installer memory verification ${marker}`,
        source_identifier: sourceIdentifier,
        source: VERIFY_SOURCE,
      }],
    },
  );
  const rememberedData = record(remembered.data, 'remember');
  const ids = rememberedData.contentIds;
  const contentId = Array.isArray(ids) && typeof ids[0] === 'string' ? ids[0] : undefined;
  if (rememberedData.completedItems !== 1 || !contentId) {
    throw new Error('Local remember check did not synchronously store one memory.');
  }

  const recalled = await request(
    fetchImpl,
    `${apiUrl}/api/v1/agent/query`,
    options.apiKey,
    'POST',
    {
      query: marker,
      searchType: 'fulltext',
      libraryId: LOCAL_LIBRARY_ID,
      limit: 5,
      include: ['content', 'summary'],
    },
  );
  const recalledData = record(recalled.data, 'recall');
  const results = Array.isArray(recalledData.results) ? recalledData.results : [];
  if (!results.some((item) => {
    return typeof item === 'object' && item !== null
      && (item as Record<string, unknown>).id === contentId;
  })) {
    throw new Error(`Local recall check did not cite remembered content ${contentId}.`);
  }

  const inspected = await request(
    fetchImpl,
    `${apiUrl}/api/v1/content/${contentId}/lineage`,
    options.apiKey,
    'GET',
  );
  const inspectedData = record(inspected.data, 'inspect_memory');
  const origin = record(inspectedData.origin, 'inspect_memory origin');
  if (
    inspectedData.source !== VERIFY_SOURCE
    || origin.externalId !== sourceIdentifier
    || !Array.isArray(inspectedData.currentArtifacts)
    || !Array.isArray(inspectedData.lineage)
  ) {
    throw new Error(`Local inspect_memory check returned invalid lineage for ${contentId}.`);
  }
  return contentId;
}

export interface ClientVerificationResult {
  client: AgentClientId;
  status: 'passed' | 'unavailable';
  detail: string;
}

export interface VerifyClientIntegrationOptions {
  clients: readonly AgentClientId[];
  coworkMode?: CoworkMode;
  runningInWsl?: boolean;
  marker: string;
  contentId: string;
  runCommand?: CommandRunner;
  prompt?: Prompt;
}

function recallPrompt(marker: string, contentId: string): string {
  return [
    'Use the configured Answer Engine recall tool, not shell, curl, or a direct HTTP request.',
    `Find the exact verification marker "${marker}".`,
    `Return the marker and expected content id "${contentId}" after the tool result.`,
  ].join(' ');
}

function parseJsonLines(output: string): unknown[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return undefined;
      }
    })
    .filter((value) => value !== undefined);
}

function collectRecords(value: unknown, records: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRecords(item, records);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const item = value as Record<string, unknown>;
  records.push(item);
  for (const child of Object.values(item)) collectRecords(child, records);
}

function isCodexRecall(item: Record<string, unknown>): boolean {
  const type = typeof item.type === 'string' ? item.type.toLowerCase() : '';
  const server = typeof item.server === 'string' ? item.server.toLowerCase() : '';
  const tool = typeof item.tool === 'string' ? item.tool.toLowerCase() : '';
  return type === 'mcp_tool_call'
    && (server === 'answer-engine' || server === 'answer_engine')
    && tool === 'recall';
}

function isClaudeRecall(item: Record<string, unknown>): boolean {
  const type = typeof item.type === 'string' ? item.type.toLowerCase() : '';
  const name = typeof item.name === 'string' ? item.name.toLowerCase() : '';
  return type === 'tool_use'
    && (name.includes('answer-engine') || name.includes('answer_engine'))
    && name.endsWith('recall');
}

function containsExpectedMemory(
  item: Record<string, unknown>,
  marker: string,
  contentId: string,
): boolean {
  const serialized = JSON.stringify(item);
  return serialized.includes(marker) && serialized.includes(contentId);
}

function hasRecallToolEvidence(output: string, marker: string, contentId: string): boolean {
  const events = parseJsonLines(output);
  const records: Record<string, unknown>[] = [];
  collectRecords(events, records);
  if (records.some((item) => isCodexRecall(item) && containsExpectedMemory(item, marker, contentId))) {
    return true;
  }
  const claudeRecallIds = new Set(records
    .filter(isClaudeRecall)
    .map((item) => item.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0));
  return records.some((item) => {
    return item.type === 'tool_result'
      && typeof item.tool_use_id === 'string'
      && claudeRecallIds.has(item.tool_use_id)
      && containsExpectedMemory(item, marker, contentId);
  });
}

export async function verifyClientIntegrations(
  options: VerifyClientIntegrationOptions,
): Promise<ClientVerificationResult[]> {
  const command = options.runCommand ?? defaultRunCommand;
  const results: ClientVerificationResult[] = [];
  for (const client of options.clients) {
    const capability = capabilityForClient(client, options.coworkMode, options.runningInWsl);
    if (!capability.supported) {
      results.push({
        client,
        status: 'unavailable',
        detail: capability.limitation ?? 'This client cannot use the selected local integration.',
      });
      continue;
    }
    if (capability.verification === 'command') {
      const prompt = recallPrompt(options.marker, options.contentId);
      let response: Awaited<ReturnType<CommandRunner>>;
      try {
        response = client === 'codex'
          ? await command('codex', ['exec', '--json', '--skip-git-repo-check', prompt])
          : await command('claude', [
            '-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', prompt,
          ]);
      } catch (error) {
        throw new Error(`${capability.label} verification command failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!hasRecallToolEvidence(response.stdout, options.marker, options.contentId)) {
        throw new Error(`${capability.label} verification did not show an Answer Engine recall tool call for the expected memory.`);
      }
      results.push({ client, status: 'passed', detail: 'Verified a real recall tool call.' });
      continue;
    }
    if (capability.verification === 'guided') {
      if (!options.prompt?.confirm) {
        throw new Error(`${capability.label} interactive verification is required; rerun interactively or remove this client from the selection.`);
      }
      const setup = client === 'chatgpt-desktop'
        ? 'Restart it and install Answer Engine from the Personal plugin marketplace, then'
        : `Restart ${capability.label}, then`;
      const confirmed = await options.prompt.confirm(
        `${setup} ask it to recall "${options.marker}" and confirm the result cites ${options.contentId}. Did it pass?`,
        false,
      );
      if (!confirmed) {
        throw new Error(`${capability.label} guided recall was not confirmed; installation remains incomplete.`);
      }
      results.push({ client, status: 'passed', detail: 'User confirmed the guided recall challenge.' });
    }
  }
  return results;
}
