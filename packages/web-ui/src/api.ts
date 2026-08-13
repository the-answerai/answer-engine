import type {
  Artifact,
  AskResult,
  ContentBlob,
  ContentFilters,
  ContentItem,
  ContentPageResult,
  ImportItem,
  ImportPreview,
  ImportResult,
  Library,
  LibraryFilter,
  LibraryMemberPage,
  LineageResult,
  PageMeta,
  Tag,
} from './types';

export type MemoryItem = ContentItem;
export type { AskResult, LineageResult } from './types';

interface ApiEnvelope<T> {
  success?: boolean;
  data?: T;
  meta?: Partial<PageMeta> & Record<string, unknown>;
  error?: { message?: string };
}

const LEGACY_API_KEY_STORAGE_KEY = 'answer-engine-api-key';
const EMPTY_META: PageMeta = { hasMore: false, nextCursor: null, total: 0 };

function isEnvelope<T>(payload: ApiEnvelope<T> | T): payload is ApiEnvelope<T> {
  return Boolean(payload && typeof payload === 'object' && 'data' in payload);
}

async function requestEnvelope<T>(path: string, init: RequestInit = {}): Promise<ApiEnvelope<T>> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...init.headers,
    },
  });
  if (response.status === 204) return { success: true };
  const payload = await response.json() as ApiEnvelope<T> | T;
  if (!response.ok) {
    const envelope = isEnvelope(payload) ? payload : undefined;
    throw new Error(envelope?.error?.message ?? `Request failed (${response.status})`);
  }
  return isEnvelope(payload) ? payload : { success: true, data: payload };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const envelope = await requestEnvelope<T>(path, init);
  return envelope.data as T;
}

function json(method: string, body?: unknown): RequestInit {
  return { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

export async function health(): Promise<boolean> {
  const response = await fetch('/health');
  return response.ok;
}

export async function initializeLocalUiSession(): Promise<void> {
  const response = await fetch('/local-ui/session', { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Unable to initialize the local browser session (${response.status})`);
}

export function clearLegacyBrowserApiKey(): void {
  try {
    window.localStorage.removeItem(LEGACY_API_KEY_STORAGE_KEY);
  } catch {
    // The HttpOnly session does not depend on browser storage being available.
  }
}

export async function listContent(filters: ContentFilters = {}): Promise<ContentPageResult> {
  const params = new URLSearchParams();
  const arrays = ['contentTypes', 'sources', 'tags'] as const;
  for (const key of arrays) {
    const value = filters[key];
    if (value?.length) params.set(key, value.join(','));
  }
  const scalars = [
    'search', 'status', 'dateFrom', 'dateTo', 'libraryId', 'sortBy', 'sortDirection', 'cursor',
  ] as const;
  for (const key of scalars) {
    const value = filters[key];
    if (value) params.set(key, String(value));
  }
  params.set('limit', String(filters.limit ?? 25));
  if (!filters.sortBy) params.set('sortBy', 'createdAt');
  if (!filters.sortDirection) params.set('sortDirection', 'desc');
  const envelope = await requestEnvelope<ContentItem[]>(`/api/v1/content?${params.toString()}`);
  return {
    items: envelope.data ?? [],
    meta: {
      hasMore: Boolean(envelope.meta?.hasMore),
      nextCursor: typeof envelope.meta?.nextCursor === 'string' ? envelope.meta.nextCursor : null,
      total: typeof envelope.meta?.total === 'number' ? envelope.meta.total : envelope.data?.length ?? 0,
    },
  };
}

export async function listMemories(limit = 50): Promise<MemoryItem[]> {
  return (await listContent({ limit })).items;
}

export function getContent(contentId: string): Promise<ContentItem> {
  return request(`/api/v1/content/${encodeURIComponent(contentId)}`);
}

export function deleteContent(contentId: string): Promise<void> {
  return request(`/api/v1/content/${encodeURIComponent(contentId)}`, json('DELETE'));
}

export async function searchMemories(query: string): Promise<MemoryItem[]> {
  const result = await request<{ items?: MemoryItem[]; results?: MemoryItem[] }>(
    '/api/v1/agent/query',
    json('POST', { query, searchType: 'fulltext', limit: 25 }),
  );
  return result.items ?? result.results ?? [];
}

export function inspectLineage(contentId: string): Promise<LineageResult> {
  return request(`/api/v1/content/${encodeURIComponent(contentId)}/lineage`);
}

export function listArtifacts(contentId: string): Promise<Artifact[]> {
  return request(`/api/v1/content/${encodeURIComponent(contentId)}/artifacts`);
}

export function listBlobs(contentId: string): Promise<ContentBlob[]> {
  return request(`/api/v1/content/${encodeURIComponent(contentId)}/blobs`);
}

export async function askAnswer(input: {
  question: string;
  libraryId?: string;
  filters?: { contentTypes?: string[]; tagSlugs?: string[]; dateFrom?: string; dateTo?: string };
}): Promise<AskResult> {
  const result = await request<Partial<AskResult>>('/api/v1/agent/ask', json('POST', {
    ...input,
    retrievalMode: 'fulltext',
    responseStyle: 'cited',
  }));
  return { ...result, answer: result.answer ?? 'No grounded answer was returned.', citations: result.citations ?? [] };
}

export function askMemory(question: string): Promise<AskResult> {
  return askAnswer({ question });
}

export function previewImport(items: ImportItem[], libraryId?: string): Promise<ImportPreview> {
  return request('/api/v1/content/import/preview', json('POST', { items, ...(libraryId ? { libraryId } : {}) }));
}

export function importContent(items: ImportItem[], libraryId?: string): Promise<ImportResult> {
  return request('/api/v1/content/import', json('POST', { items, ...(libraryId ? { libraryId } : {}) }));
}

export async function importMemory(input: { title: string; content: string }): Promise<void> {
  await importContent([{
    title: input.title,
    content: input.content,
    contentType: 'document',
    source: 'local-ui',
    sourceIdentifier: `local-ui:${crypto.randomUUID()}`,
    metadata: { importedBy: 'local-ui' },
  }]);
}

export function listTags(): Promise<Tag[]> {
  return request('/api/v1/tags');
}

export function createTag(input: Omit<Partial<Tag>, 'id'> & Pick<Tag, 'slug' | 'label'>): Promise<Tag> {
  return request('/api/v1/tags', json('POST', input));
}

export function updateTag(id: string, input: Partial<Tag>): Promise<Tag> {
  return request(`/api/v1/tags/${encodeURIComponent(id)}`, json('PATCH', input));
}

export function deleteTag(id: string): Promise<void> {
  return request(`/api/v1/tags/${encodeURIComponent(id)}`, json('DELETE'));
}

export function assignTag(tagId: string, contentIds: string[], assigned: boolean): Promise<{ changed: number }> {
  return request(`/api/v1/tags/${encodeURIComponent(tagId)}/content`, json(assigned ? 'POST' : 'DELETE', { contentIds }));
}

export function listLibraries(): Promise<Library[]> {
  return request('/api/v1/libraries');
}

export function getLibrary(libraryId: string): Promise<Library> {
  return request(`/api/v1/libraries/${encodeURIComponent(libraryId)}`);
}

export function createLibrary(input: { name: string; slug: string; description?: string | null; filter?: LibraryFilter | null }): Promise<Library> {
  return request('/api/v1/libraries', json('POST', { ...input, metadata: {} }));
}

export function updateLibrary(libraryId: string, input: { name?: string; slug?: string; description?: string | null; filter?: LibraryFilter | null }): Promise<Library> {
  return request(`/api/v1/libraries/${encodeURIComponent(libraryId)}`, json('PATCH', input));
}

export function deleteLibrary(libraryId: string): Promise<void> {
  return request(`/api/v1/libraries/${encodeURIComponent(libraryId)}`, json('DELETE'));
}

export function listLibraryMembers(libraryId: string, input: { query?: string; cursor?: string; limit?: number } = {}): Promise<LibraryMemberPage> {
  const params = new URLSearchParams({ limit: String(input.limit ?? 25) });
  if (input.query) params.set('query', input.query);
  if (input.cursor) params.set('cursor', input.cursor);
  return request(`/api/v1/libraries/${encodeURIComponent(libraryId)}/members?${params.toString()}`);
}

export function previewLibrary(libraryId: string, filter: LibraryFilter | null): Promise<LibraryMemberPage> {
  return request(`/api/v1/libraries/${encodeURIComponent(libraryId)}/preview`, json('POST', { filter, limit: 25 }));
}

export function setLibraryMembership(
  libraryId: string,
  contentId: string,
  mode: 'include' | 'exclude',
  active: boolean,
): Promise<{ libraryId: string; contentId: string; mode: string; active: boolean }> {
  return request(
    `/api/v1/libraries/${encodeURIComponent(libraryId)}/${mode}s/${encodeURIComponent(contentId)}`,
    json(active ? 'PUT' : 'DELETE'),
  );
}

export { EMPTY_META };
