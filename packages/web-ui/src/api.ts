export interface MemoryItem {
  id: string;
  title?: string;
  content?: string;
  summary?: string;
  contentType?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
  score?: number;
  relevanceScore?: number;
}

export interface Citation {
  contentId?: string;
  id?: string;
  title?: string;
  excerpt?: string;
  source?: string;
}

export interface AskResult {
  answer: string;
  citations: Citation[];
}

export interface LineageResult {
  content?: MemoryItem;
  lineage?: unknown;
  [key: string]: unknown;
}

interface ApiEnvelope<T> {
  success?: boolean;
  data?: T;
  error?: { message?: string };
}

function unwrap<T>(payload: ApiEnvelope<T> | T): T {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    const envelope = payload as ApiEnvelope<T>;
    if (envelope.data !== undefined) return envelope.data;
  }
  return payload as T;
}

function apiKey(): string {
  return window.localStorage.getItem('answer-engine-api-key') ?? '';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = apiKey();
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'x-api-key': key } : {}),
      ...init.headers,
    },
  });

  const payload = await response.json() as ApiEnvelope<T> | T;
  if (!response.ok) {
    const envelope = payload as ApiEnvelope<T>;
    throw new Error(envelope.error?.message ?? `Request failed (${response.status})`);
  }
  return unwrap(payload);
}

export function saveApiKey(key: string): void {
  const normalized = key.trim();
  if (!normalized.startsWith('ae_live_')) {
    throw new Error('Local API keys begin with ae_live_.');
  }
  window.localStorage.setItem('answer-engine-api-key', normalized);
}

export function hasApiKey(): boolean {
  return apiKey().length > 0;
}

export function clearApiKey(): void {
  window.localStorage.removeItem('answer-engine-api-key');
}

export async function health(): Promise<boolean> {
  const response = await fetch('/health');
  return response.ok;
}

export async function listMemories(limit = 50): Promise<MemoryItem[]> {
  const result = await request<MemoryItem[] | { items?: MemoryItem[] }>(
    `/api/v1/content?limit=${limit}&sortBy=createdAt&sortDirection=desc`,
  );
  return Array.isArray(result) ? result : result.items ?? [];
}

export async function searchMemories(query: string): Promise<MemoryItem[]> {
  const result = await request<{ items?: MemoryItem[]; results?: MemoryItem[] }>(
    '/api/v1/agent/query',
    { method: 'POST', body: JSON.stringify({ query, searchType: 'fulltext', limit: 25 }) },
  );
  return result.items ?? result.results ?? [];
}

export async function askMemory(question: string): Promise<AskResult> {
  const result = await request<Partial<AskResult>>('/api/v1/agent/ask', {
    method: 'POST',
    body: JSON.stringify({ question, retrievalMode: 'fulltext', responseStyle: 'cited' }),
  });
  return {
    answer: result.answer ?? 'No grounded answer was returned.',
    citations: result.citations ?? [],
  };
}

export async function importMemory(input: {
  title: string;
  content: string;
}): Promise<void> {
  await request('/api/v1/content/import', {
    method: 'POST',
    body: JSON.stringify({
      items: [{
        title: input.title,
        content: input.content,
        contentType: 'document',
        source: 'local-ui',
        metadata: { importedBy: 'local-ui' },
      }],
    }),
  });
}

export async function inspectLineage(contentId: string): Promise<LineageResult> {
  return request<LineageResult>(`/api/v1/content/${encodeURIComponent(contentId)}/lineage`);
}
