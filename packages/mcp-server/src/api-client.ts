/**
 * Answer Engine API Client
 * HTTP wrapper for local memory and retrieval endpoints
 */

interface ApiResponse<T> {
  success: boolean;
  data: T;
  meta?: Record<string, unknown>;
}

interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ApiClientConfig {
  apiUrl: string;
  apiKey: string;
  libraryId?: string;
  librarySlug?: string;
}

export interface LibraryScope {
  type: 'library';
  libraryId: string;
  librarySlug: string;
  libraryName: string;
  itemCount: number;
}

type ScopedAgentInput = {
  libraryId?: string;
  librarySlug?: string;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseLibraryScope(value: string | undefined): Partial<ScopedAgentInput> {
  const trimmed = value?.trim();
  if (!trimmed) return {};
  return UUID_PATTERN.test(trimmed)
    ? { libraryId: trimmed }
    : { librarySlug: trimmed };
}

export class AnswerEngineClient {
  private apiUrl: string;
  private apiKey: string;
  private libraryId?: string;
  private librarySlug?: string;

  constructor(config: ApiClientConfig) {
    this.apiUrl = config.apiUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    const envScope =
      config.libraryId || config.librarySlug
        ? {}
        : parseLibraryScope(process.env.ANSWER_ENGINE_LIBRARY);
    this.libraryId = config.libraryId ?? envScope.libraryId;
    this.librarySlug = config.librarySlug ?? envScope.librarySlug;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-API-Key': this.apiKey,
      'X-AE-Surface': 'mcp',
    };

    const options: RequestInit = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(`${this.apiUrl}${path}`, options);

    // 204 No Content (e.g. DELETE) has no body to parse.
    if (response.status === 204) {
      return { success: true, data: undefined as T };
    }

    const data = (await response.json()) as ApiResponse<T> | ApiErrorResponse;

    if (!response.ok) {
      const errorData = data as ApiErrorResponse;
      const code = errorData.error?.code ?? `HTTP_${response.status}`;
      const message =
        errorData.error?.message ?? `Request failed with status ${response.status}`;
      throw new ApiError(response.status, code, message);
    }

    return data as ApiResponse<T>;
  }

  // Agent endpoints
  async getSchema(): Promise<ApiResponse<SchemaResponse>> {
    const params = this.defaultScopeParams();
    const query = params.toString();
    return this.request<SchemaResponse>(
      'GET',
      `/api/v1/agent/schema${query ? `?${query}` : ''}`
    );
  }

  async query(input: QueryInput): Promise<ApiResponse<QueryResult>> {
    return this.request<QueryResult>(
      'POST',
      '/api/v1/agent/query',
      this.withDefaultScope(input) as unknown as Record<string, unknown>
    );
  }

  async retrieve(input: RetrieveInput): Promise<ApiResponse<RetrieveResult>> {
    return this.request<RetrieveResult>(
      'POST',
      '/api/v1/agent/retrieve',
      this.withDefaultScope(input) as unknown as Record<string, unknown>
    );
  }

  async summarize(input: SummarizeInput): Promise<ApiResponse<SummarizeResult>> {
    return this.request<SummarizeResult>(
      'POST',
      '/api/v1/agent/summarize',
      this.withDefaultScope(input) as unknown as Record<string, unknown>
    );
  }

  async ask(input: AskInput): Promise<ApiResponse<AskResult>> {
    return this.request<AskResult>(
      'POST',
      '/api/v1/agent/ask',
      this.withDefaultScope(input) as unknown as Record<string, unknown>
    );
  }

  async saveContent(input: SaveContentInput): Promise<ApiResponse<SaveContentResult>> {
    return this.request<SaveContentResult>(
      'POST',
      '/api/v1/content/import',
      this.withDefaultScope(input) as unknown as Record<string, unknown>
    );
  }

  async getLineage(contentId: string): Promise<ApiResponse<ContentLineageResult>> {
    return this.request<ContentLineageResult>('GET', `/api/v1/content/${contentId}/lineage`);
  }

  /**
   * Soft-remove a memory so it is no longer returned by recall/search.
   * Backed by DELETE /api/v1/content/:id (status -> 'deleted'); this is NOT a
   * permanent erase. Throws ApiError(404) when the id does not exist.
   */
  async deleteContent(contentId: string): Promise<ApiResponse<null>> {
    return this.request<null>('DELETE', `/api/v1/content/${contentId}`);
  }

  async getRecentContent(limit = 10): Promise<ApiResponse<ContentListItem[]>> {
    const params = new URLSearchParams({
      limit: String(limit),
      sortBy: 'createdAt',
      sortDirection: 'desc',
    });

    const defaultLibrary = this.libraryId ?? this.librarySlug;
    if (defaultLibrary) {
      params.set('libraryId', defaultLibrary);
    }

    return this.request<ContentListItem[]>('GET', `/api/v1/content?${params.toString()}`);
  }

  private withDefaultScope<T extends ScopedAgentInput>(input: T): T {
    if (input.libraryId || input.librarySlug) return input;

    const defaultScope: Partial<ScopedAgentInput> = {};
    if (this.libraryId) defaultScope.libraryId = this.libraryId;
    if (this.librarySlug) defaultScope.librarySlug = this.librarySlug;

    if (!defaultScope.libraryId && !defaultScope.librarySlug) return input;
    return { ...input, ...defaultScope };
  }

  private defaultScopeParams(): URLSearchParams {
    const params = new URLSearchParams();
    if (this.libraryId) params.set('libraryId', this.libraryId);
    if (this.librarySlug) params.set('librarySlug', this.librarySlug);
    return params;
  }

}

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Type interfaces matching the API
// Canonical source: src/types/agent.types.ts — keep in sync
export type ArtifactType =
  | 'raw_text'
  | 'cleaned_text'
  | 'extraction_json'
  | 'generated_field'
  | 'analysis_variant';

export type TextSource = 'compatibility' | ArtifactType;

export type TextKind = 'raw' | 'cleaned' | 'synthesized' | 'structured' | 'compatibility';

export interface ContentArtifactSummary {
  id: string;
  artifactType: ArtifactType;
  textKind: TextKind;
  status: 'pending' | 'success' | 'no_content' | 'error' | 'superseded';
  supersedesId: string | null;
  sourceContentIds: string[];
  version: number;
  isCurrent: boolean;
  recipeVersion: string | null;
  modelId: string | null;
  promptHash: string | null;
  createdAt: string;
  textContent?: string | null;
  dataJson?: Record<string, unknown> | null;
}

export interface ContentArtifactLineageVersion extends ContentArtifactSummary {
  replacedById: string | null;
  replacedByVersion: number | null;
}

export interface ContentArtifactLineageGroup {
  artifactType: ArtifactType;
  analysisConfigId: string | null;
  recipeName: string | null;
  versions: ContentArtifactLineageVersion[];
}

export interface ContentLineageResult {
  source: string | null;
  origin: {
    sourceUrl: string | null;
    externalId: string | null;
  };
  currentArtifacts: ContentArtifactSummary[];
  lineage: ContentArtifactLineageGroup[];
}

export interface SchemaResponse {
  contentTypes: Record<string, number>;
  tags: Array<{
    slug: string;
    label: string;
    description: string | null;
    category: string | null;
  }>;
  capabilities: string[];
  dateRange: { earliest: string | null; latest: string | null };
}

export interface QueryInput {
  query: string;
  libraryId?: string;
  librarySlug?: string;
  conversationId?: string;
  sourceAgentId?: string;
  searchType?: 'fulltext' | 'semantic' | 'hybrid';
  filters?: {
    contentTypes?: SaveContentContentType[];
    tags?: string[];
    dateFrom?: string;
    dateTo?: string;
    status?: 'active' | 'archived';
  };
  include?: Array<'summary' | 'content' | 'metadata'>;
  limit?: number;
}

export interface QueryResultItem {
  id: string;
  contentType: string;
  title: string;
  summary?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown>;
  textKind: TextKind;
  relevanceScore: number;
  createdAt: string;
}

export interface QueryResult {
  results: QueryResultItem[];
  total: number;
  searchType: string;
  scope?: LibraryScope;
}

export interface RetrieveInput {
  ids?: string[];
  libraryId?: string;
  librarySlug?: string;
  conversationId?: string;
  sourceAgentId?: string;
  include?: Array<'summary' | 'content' | 'metadata'>;
}

export interface RetrieveResultItem {
  id: string;
  contentType: string;
  title: string;
  summary?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown>;
  textKind: TextKind;
  sourceUrl: string | null;
  sourceAgentId?: string | null;
  conversationId?: string | null;
  turnIndex?: number | null;
  turnRole?: 'user' | 'assistant' | 'system' | 'tool' | 'developer' | 'other' | null;
  turnTimestamp?: string | null;
  turnMetadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface RetrieveResult {
  items: RetrieveResultItem[];
  scope?: LibraryScope;
}

export interface ContentListItem {
  id: string;
  contentType: string;
  title: string;
  summary?: string | null;
  content?: string | null;
  tags?: Array<{ slug: string; label: string; category: string | null }>;
  metadata?: Record<string, unknown>;
  textKind?: TextKind;
  sourceUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SummarizeInput {
  prompt: string;
  libraryId?: string;
  librarySlug?: string;
  filter?: {
    contentTypes?: string[];
    tags?: string[];
    dateFrom?: string;
    dateTo?: string;
  };
  limit?: number;
}

export interface SummarizeResult {
  summary: string;
  sourceCount: number;
  scope?: LibraryScope;
  prompt: string;
}

export interface AskInput {
  question: string;
  contentIds?: string[];
  libraryId?: string;
  librarySlug?: string;
  conversationId?: string;
  sourceAgentId?: string;
  retrievalMode?: 'fulltext' | 'semantic' | 'hybrid';
  responseStyle?: 'cited' | 'conversational';
  filters?: {
    contentTypes?: SaveContentContentType[];
    tagSlugs?: string[];
    dateFrom?: string;
    dateTo?: string;
  };
}

export interface AskCitation {
  contentId: string;
  title: string;
  contentType: string;
  relevanceScore: number;
  excerpt: string;
}

export interface AskResult {
  answer: string;
  citations: AskCitation[];
  modelId?: string;
  provider?: string;
  retrievalMode: 'fulltext' | 'semantic' | 'hybrid';
  responseStyle: 'cited' | 'conversational';
  scope?: LibraryScope;
}

export type SaveContentContentType =
  | 'call'
  | 'document'
  | 'ticket'
  | 'chat'
  | 'page';

export interface SaveContentImportRow {
  title: string;
  content_type: SaveContentContentType;
  source_identifier?: string;
  content?: string;
  external_url?: string;
  source?: string;
  source_agent_id?: string;
  conversation_id?: string;
  turn_index?: number;
  turn_role?: 'user' | 'assistant' | 'system' | 'tool' | 'developer' | 'other';
  turn_timestamp?: string;
  turn_metadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  source_data?: Record<string, unknown>;
  analysis_data?: Record<string, unknown>;
}

export interface SaveContentInput extends ScopedAgentInput {
  items: SaveContentImportRow[];
}

export interface SaveContentResultItem {
  rowIndex: number;
  id: string;
  contentType: string;
  sourceIdentifier: string;
  title: string;
}

export interface SaveContentFailure {
  rowIndex: number;
  sourceIdentifier: string;
  error: string;
}

export interface SaveContentParseError {
  rowIndex: number;
  col?: string;
  error: string;
}

export interface SaveContentResult {
  contentIds: string[];
  items: SaveContentResultItem[];
  totalItems: number;
  completedItems: number;
  failedItems: number;
  failures: SaveContentFailure[];
  scope?: LibraryScope;
  parseErrors: SaveContentParseError[];
  requiresIdForIdempotency: boolean;
}
