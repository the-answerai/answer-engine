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

function hasRecallToolEvidence(output: string, marker: string, contentId: string): boolean {
  const normalized = output.toLowerCase();
  const namesAnswerEngine = normalized.includes('answer-engine') || normalized.includes('answer_engine');
  const namesRecall = normalized.includes('recall');
  const namesToolEvent = normalized.includes('mcp_tool_call')
    || normalized.includes('tool_use')
    || normalized.includes('tool.call')
    || normalized.includes('mcp__');
  return namesAnswerEngine && namesRecall && namesToolEvent
    && output.includes(marker) && output.includes(contentId);
}

export async function verifyClientIntegrations(
  options: VerifyClientIntegrationOptions,
): Promise<ClientVerificationResult[]> {
  const command = options.runCommand ?? defaultRunCommand;
  const results: ClientVerificationResult[] = [];
  for (const client of options.clients) {
    const capability = capabilityForClient(client, options.coworkMode);
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
      const confirmed = await options.prompt.confirm(
        `Restart ${capability.label}, ask it to recall "${options.marker}", and confirm the result cites ${options.contentId}. Did it pass?`,
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
