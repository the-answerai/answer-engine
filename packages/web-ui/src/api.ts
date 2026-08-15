import type {
  Artifact,
  AccessToken,
  AuditEntry,
  AskResult,
  BatchJob,
  CursorPage,
  Dashboard,
  DashboardLayoutItem,
  DashboardWidget,
  ContentBlob,
  ContentFilters,
  ContentItem,
  ContentPageResult,
  ImportItem,
  ImportPreview,
  ImportResult,
  FirstImportSession,
  FirstImportSourceId,
  FolderSource,
  Library,
  LibraryFilter,
  LibraryMemberPage,
  LineageResult,
  LocalSettings,
  MintedAccessToken,
  OrganizationDecision,
  OrganizationPlan,
  RecallClientCapability,
  RecallTutorial,
  RecallTutorialClient,
  PageMeta,
  Recipe,
  RecipeInput,
  RecipePreviewItem,
  RecipeRun,
  ReportDefinition,
  ReportInput,
  GeneratedReport,
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
  return Boolean(
    payload
    && typeof payload === 'object'
    && ('success' in payload || 'data' in payload || 'error' in payload || 'meta' in payload),
  );
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

export interface HealthStatus {
  status: string;
  uptime: number;
  channel: 'stable' | 'staging';
}

export async function health(): Promise<HealthStatus> {
  const response = await fetch('/health');
  if (!response.ok) throw new Error(`Health check failed (${response.status})`);
  const payload = await response.json() as Partial<HealthStatus>;
  if (
    payload.status !== 'healthy'
    || typeof payload.uptime !== 'number'
    || (payload.channel !== 'stable' && payload.channel !== 'staging')
  ) {
    throw new Error('Health check returned an invalid runtime channel identity.');
  }
  return payload as HealthStatus;
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

export function getArtifact(artifactId: string): Promise<Artifact> {
  return request(`/api/v1/artifacts/${encodeURIComponent(artifactId)}`);
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

export function createOrganizationProposal(input: { useModel: boolean; limit: number }): Promise<OrganizationPlan> {
  return request('/api/v1/organization-plans', json('POST', input));
}

export function listOrganizationPlans(): Promise<OrganizationPlan[]> {
  return request('/api/v1/organization-plans');
}

export function applyOrganizationPlan(planId: string, decisions: OrganizationDecision[]): Promise<OrganizationPlan> {
  return request(`/api/v1/organization-plans/${encodeURIComponent(planId)}/apply`, json('POST', { decisions }));
}

export function undoOrganizationPlan(planId: string): Promise<OrganizationPlan> {
  return request(`/api/v1/organization-plans/${encodeURIComponent(planId)}/undo`, json('POST'));
}

export function recallTutorialCapabilities(environment: 'native' | 'wsl' = 'native'): Promise<RecallClientCapability[]> {
  return request(`/api/v1/recall-tutorials/capabilities?environment=${environment}`);
}
export function listRecallTutorials(): Promise<RecallTutorial[]> { return request('/api/v1/recall-tutorials'); }
export function createRecallTutorial(input: { writeClient: RecallTutorialClient; recallClient: RecallTutorialClient; environment: 'native' | 'wsl' }): Promise<RecallTutorial> {
  return request('/api/v1/recall-tutorials', json('POST', input));
}
export function checkRecallTutorial(id: string, reportedFailure?: 'runtime' | 'wiring' | 'access' | 'indexing' | 'retrieval'): Promise<RecallTutorial> {
  return request(`/api/v1/recall-tutorials/${encodeURIComponent(id)}/check`, json('POST', reportedFailure ? { reportedFailure } : {}));
}

export function latestFirstImport(): Promise<FirstImportSession | null> {
  return request('/api/v1/first-imports/latest');
}

export function approveFirstImport(sessionId: string, sourceIds: FirstImportSourceId[]): Promise<FirstImportSession> {
  return request(`/api/v1/first-imports/${encodeURIComponent(sessionId)}/approve`, json('POST', { sourceIds }));
}

export function cancelFirstImport(sessionId: string): Promise<FirstImportSession> {
  return request(`/api/v1/first-imports/${encodeURIComponent(sessionId)}/cancel`, json('POST'));
}

export function retryFirstImport(sessionId: string): Promise<FirstImportSession> {
  return request(`/api/v1/first-imports/${encodeURIComponent(sessionId)}/retry`, json('POST'));
}

export function latestFolderSource(): Promise<FolderSource | null> {
  return request('/api/v1/folder-sources/latest');
}
export function approveFolderRun(runId: string): Promise<FolderSource> {
  return request(`/api/v1/folder-sources/runs/${encodeURIComponent(runId)}/approve`, json('POST'));
}
export function cancelFolderRun(runId: string): Promise<FolderSource> {
  return request(`/api/v1/folder-sources/runs/${encodeURIComponent(runId)}/cancel`, json('POST'));
}
export function retryFolderRun(runId: string): Promise<FolderSource> {
  return request(`/api/v1/folder-sources/runs/${encodeURIComponent(runId)}/retry`, json('POST'));
}
export function prepareFolderRemoval(sourceId: string, retention: 'keep' | 'delete'): Promise<FolderSource> {
  return request(`/api/v1/folder-sources/${encodeURIComponent(sourceId)}/remove`, json('POST', { retention }));
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

const libraryPath = (libraryId: string) => `/api/v1/libraries/${encodeURIComponent(libraryId)}`;

export function listRecipes(libraryId: string): Promise<Recipe[]> {
  return request(`${libraryPath(libraryId)}/recipes`);
}
export function createRecipe(libraryId: string, input: RecipeInput): Promise<Recipe> {
  return request(`${libraryPath(libraryId)}/recipes`, json('POST', input));
}
export function updateRecipe(libraryId: string, recipeId: string, input: Partial<RecipeInput>): Promise<Recipe> {
  return request(`${libraryPath(libraryId)}/recipes/${encodeURIComponent(recipeId)}`, json('PATCH', input));
}
export function deleteRecipe(libraryId: string, recipeId: string): Promise<void> {
  return request(`${libraryPath(libraryId)}/recipes/${encodeURIComponent(recipeId)}`, json('DELETE'));
}
export function previewRecipe(libraryId: string, recipeId: string, input: { contentIds?: string[]; limit?: number } = {}): Promise<{ items: RecipePreviewItem[] }> {
  return request(`${libraryPath(libraryId)}/recipes/${encodeURIComponent(recipeId)}/preview`, json('POST', { limit: 3, ...input }));
}
export function runRecipe(libraryId: string, recipeId: string): Promise<RecipeRun> {
  return request(`${libraryPath(libraryId)}/recipes/${encodeURIComponent(recipeId)}/runs`, json('POST'));
}
export function listRecipeRuns(libraryId: string, recipeId: string): Promise<RecipeRun[]> {
  return request(`${libraryPath(libraryId)}/recipes/${encodeURIComponent(recipeId)}/runs`);
}
export function getRecipeRun(libraryId: string, runId: string): Promise<RecipeRun> {
  return request(`${libraryPath(libraryId)}/runs/${encodeURIComponent(runId)}`);
}
export function cancelRecipeRun(libraryId: string, runId: string): Promise<RecipeRun> {
  return request(`${libraryPath(libraryId)}/runs/${encodeURIComponent(runId)}/cancel`, json('POST'));
}
export function retryRecipeRun(libraryId: string, runId: string): Promise<RecipeRun> {
  return request(`${libraryPath(libraryId)}/runs/${encodeURIComponent(runId)}/retry`, json('POST'));
}

export function listReports(libraryId: string): Promise<ReportDefinition[]> { return request(`${libraryPath(libraryId)}/reports`); }
export function createReport(libraryId: string, input: ReportInput): Promise<ReportDefinition> { return request(`${libraryPath(libraryId)}/reports`, json('POST', input)); }
export function updateReport(libraryId: string, reportId: string, input: Partial<ReportInput>): Promise<ReportDefinition> { return request(`${libraryPath(libraryId)}/reports/${encodeURIComponent(reportId)}`, json('PATCH', input)); }
export function deleteReport(libraryId: string, reportId: string): Promise<void> { return request(`${libraryPath(libraryId)}/reports/${encodeURIComponent(reportId)}`, json('DELETE')); }
export function generateReport(libraryId: string, reportId: string): Promise<GeneratedReport> { return request(`${libraryPath(libraryId)}/reports/${encodeURIComponent(reportId)}/generate`, json('POST')); }
export function listGeneratedReports(libraryId: string, reportId: string): Promise<GeneratedReport[]> { return request(`${libraryPath(libraryId)}/reports/${encodeURIComponent(reportId)}/generated`); }
export function cancelGeneratedReport(libraryId: string, reportId: string, generatedId: string): Promise<GeneratedReport> { return request(`${libraryPath(libraryId)}/reports/${encodeURIComponent(reportId)}/generated/${encodeURIComponent(generatedId)}/cancel`, json('POST')); }
export function retryGeneratedReport(libraryId: string, reportId: string, generatedId: string): Promise<GeneratedReport> { return request(`${libraryPath(libraryId)}/reports/${encodeURIComponent(reportId)}/generated/${encodeURIComponent(generatedId)}/retry`, json('POST')); }

export function listDashboards(libraryId: string): Promise<Dashboard[]> { return request(`${libraryPath(libraryId)}/dashboards`); }
export function createDashboard(libraryId: string, input: { name: string; description?: string | null; layout: DashboardLayoutItem[]; widgets: DashboardWidget[] }): Promise<Dashboard> { return request(`${libraryPath(libraryId)}/dashboards`, json('POST', input)); }
export function updateDashboard(libraryId: string, dashboardId: string, input: Partial<Pick<Dashboard, 'name' | 'description' | 'layout' | 'widgets'>>): Promise<Dashboard> { return request(`${libraryPath(libraryId)}/dashboards/${encodeURIComponent(dashboardId)}`, json('PATCH', input)); }
export function deleteDashboard(libraryId: string, dashboardId: string): Promise<void> { return request(`${libraryPath(libraryId)}/dashboards/${encodeURIComponent(dashboardId)}`, json('DELETE')); }

export function listBatchJobs(input: { cursor?: string; limit?: number } = {}): Promise<CursorPage<BatchJob>> {
  const params = new URLSearchParams({ limit: String(input.limit ?? 25) });
  if (input.cursor) params.set('cursor', input.cursor);
  return request(`/api/v1/batch-jobs?${params.toString()}`);
}
export function createBatchJob(input: { libraryId?: string | null; kind: BatchJob['kind']; name: string; input: Record<string, unknown>; contentIds?: string[] }): Promise<BatchJob> { return request('/api/v1/batch-jobs', json('POST', input)); }
export function getBatchJob(jobId: string): Promise<BatchJob> { return request(`/api/v1/batch-jobs/${encodeURIComponent(jobId)}`); }
export function cancelBatchJob(jobId: string): Promise<BatchJob> { return request(`/api/v1/batch-jobs/${encodeURIComponent(jobId)}/cancel`, json('POST')); }
export function retryBatchJob(jobId: string): Promise<BatchJob> { return request(`/api/v1/batch-jobs/${encodeURIComponent(jobId)}/retry`, json('POST')); }

export function listAccessTokens(): Promise<AccessToken[]> { return request('/api/v1/access-tokens'); }
export function createAccessToken(input: { name: string; description?: string | null; libraryId?: string | null; expiresAt?: string | null; capabilities: Array<'read' | 'write'> }): Promise<MintedAccessToken> { return request('/api/v1/access-tokens', json('POST', input)); }
export function updateAccessToken(tokenId: string, input: { name?: string; description?: string | null; expiresAt?: string | null }): Promise<AccessToken> { return request(`/api/v1/access-tokens/${encodeURIComponent(tokenId)}`, json('PATCH', input)); }
export function revokeAccessToken(tokenId: string): Promise<{ id: string; revoked: boolean }> { return request(`/api/v1/access-tokens/${encodeURIComponent(tokenId)}`, json('DELETE')); }

export function listAudit(input: { libraryId?: string; action?: string; resourceType?: string; cursor?: string; limit?: number } = {}): Promise<CursorPage<AuditEntry>> {
  const params = new URLSearchParams({ limit: String(input.limit ?? 25) });
  for (const key of ['libraryId', 'action', 'resourceType', 'cursor'] as const) if (input[key]) params.set(key, input[key] as string);
  return request(`/api/v1/audit?${params.toString()}`);
}

export function getSettings(): Promise<LocalSettings> {
  return request('/api/v1/settings');
}

export function updateSettings(input: Partial<LocalSettings>): Promise<LocalSettings> {
  return request('/api/v1/settings', json('PATCH', input));
}

export function downloadTextFile(fileName: string, content: string, mediaType = 'text/plain;charset=utf-8'): void {
  const blobUrl = URL.createObjectURL(new Blob([content], { type: mediaType }));
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = fileName.replace(/[^a-zA-Z0-9._-]+/g, '-');
  anchor.click();
  URL.revokeObjectURL(blobUrl);
}

function csvCell(value: unknown): string {
  const normalized = value ?? '';
  const text = typeof normalized === 'string' ? normalized : JSON.stringify(normalized);
  return `"${text.replace(/"/g, '""')}"`;
}

export function rowsToCsv(rows: Array<Record<string, unknown>>): string {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [columns.map(csvCell).join(','), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))].join('\n');
}

export { EMPTY_META };
