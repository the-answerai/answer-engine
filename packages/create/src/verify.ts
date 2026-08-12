import { randomUUID } from 'node:crypto';

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
