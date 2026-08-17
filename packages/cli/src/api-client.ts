/**
 * Answer Engine API Client
 * HTTP wrapper for local content, sync, and agent endpoints
 */

import { z } from 'zod';

const HealthResponseSchema = z.object({
  status: z.literal('healthy'),
  uptime: z.number(),
  channel: z.enum(['stable', 'staging']),
});

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class AnswerEngineClient {
  private channelVerification?: Promise<void>;

  constructor(
    private apiUrl: string,
    private apiKey: string,
    private expectedChannel?: HealthResponse['channel'],
  ) {
    this.apiUrl = apiUrl.replace(/\/+$/, '');
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    requestOptions: { surface?: 'cli' | 'cli-sync' } = {}
  ): Promise<ApiResponse<T>> {
    await this.ensureRuntimeChannel();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-API-Key': this.apiKey,
      'X-AE-Surface': requestOptions.surface ?? 'cli',
      'X-AE-Client': 'cli',
    };

    const options: RequestInit = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(`${this.apiUrl}${path}`, options);
    const data = await response.json() as ApiResponse<T> | ApiErrorResponse;

    if (!response.ok) {
      const err = data as ApiErrorResponse;
      throw new ApiError(response.status, err.error?.code ?? `HTTP_${response.status}`, err.error?.message ?? `Request failed: ${response.status}`);
    }

    return data as ApiResponse<T>;
  }

  private async ensureRuntimeChannel(): Promise<void> {
    if (!this.expectedChannel) return;
    this.channelVerification ??= this.healthCheck().then(() => undefined);
    await this.channelVerification;
  }

  async importPreview(input: ImportRequest): Promise<ApiResponse<ImportPreviewResult>> {
    return this.request<ImportPreviewResult>(
      'POST',
      '/api/v1/content/import/preview',
      input as unknown as Record<string, unknown>
    );
  }

  async submitImport(input: ImportRequest): Promise<ApiResponse<ImportSubmitResult>> {
    return this.request<ImportSubmitResult>(
      'POST',
      '/api/v1/content/import',
      input as unknown as Record<string, unknown>
    );
  }

  async submitSyncImport(input: ImportRequest): Promise<ApiResponse<ImportSubmitResult>> {
    return this.request<ImportSubmitResult>(
      'POST',
      '/api/v1/content/import',
      input as unknown as Record<string, unknown>,
      { surface: 'cli-sync' }
    );
  }

  async getRawArchiveReferences(): Promise<ApiResponse<{ manifestPaths: string[] }>> {
    return this.request<{ manifestPaths: string[] }>(
      'GET',
      '/api/v1/content/raw-archive-references',
      undefined,
      { surface: 'cli-sync' },
    );
  }

  async deleteContent(contentId: string): Promise<void> {
    await this.ensureRuntimeChannel();
    const response = await fetch(
      `${this.apiUrl}/api/v1/content/${encodeURIComponent(contentId)}`,
      {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
          'X-AE-Surface': 'cli-sync',
          'X-AE-Client': 'cli',
        },
      },
    );
    if (response.ok) return;

    let error: ApiErrorResponse | undefined;
    try {
      error = await response.json() as ApiErrorResponse;
    } catch {
      error = undefined;
    }
    throw new ApiError(
      response.status,
      error?.error?.code ?? `HTTP_${response.status}`,
      error?.error?.message ?? `Request failed: ${response.status}`,
    );
  }

  async registerFirstImport(input: FirstImportDiscoveryRequest): Promise<ApiResponse<FirstImportSession>> {
    return this.request('POST', '/api/v1/first-imports', input as unknown as Record<string, unknown>);
  }

  async latestFirstImport(): Promise<ApiResponse<FirstImportSession | null>> {
    return this.request('GET', '/api/v1/first-imports/latest');
  }

  async getFirstImport(sessionId: string): Promise<ApiResponse<FirstImportSession>> {
    return this.request('GET', `/api/v1/first-imports/${encodeURIComponent(sessionId)}`);
  }

  async startFirstImport(sessionId: string): Promise<ApiResponse<FirstImportSession>> {
    return this.request('POST', `/api/v1/first-imports/${encodeURIComponent(sessionId)}/start`, {});
  }

  async recordFirstImportEvent(sessionId: string, event: FirstImportEventRequest): Promise<ApiResponse<FirstImportSession>> {
    return this.request('POST', `/api/v1/first-imports/${encodeURIComponent(sessionId)}/events`, event as unknown as Record<string, unknown>);
  }

  async completeFirstImport(sessionId: string): Promise<ApiResponse<FirstImportSession>> {
    return this.request('POST', `/api/v1/first-imports/${encodeURIComponent(sessionId)}/complete`, {});
  }

  async registerFolderSource(input: FolderSourceDiscoveryRequest): Promise<ApiResponse<FolderSource>> {
    return this.request('POST', '/api/v1/folder-sources', input as unknown as Record<string, unknown>);
  }

  async listFolderSources(): Promise<ApiResponse<FolderSource[]>> {
    return this.request('GET', '/api/v1/folder-sources');
  }

  async getFolderSource(sourceId: string): Promise<ApiResponse<FolderSource>> {
    return this.request('GET', `/api/v1/folder-sources/${encodeURIComponent(sourceId)}`);
  }

  async approveFolderRun(runId: string): Promise<ApiResponse<FolderSource>> {
    return this.request('POST', `/api/v1/folder-sources/runs/${encodeURIComponent(runId)}/approve`, {});
  }

  async startFolderRun(runId: string): Promise<ApiResponse<FolderSource>> {
    return this.request('POST', `/api/v1/folder-sources/runs/${encodeURIComponent(runId)}/start`, {});
  }

  async recordFolderEvent(runId: string, event: FolderIngestionEventRequest): Promise<ApiResponse<FolderSource>> {
    return this.request('POST', `/api/v1/folder-sources/runs/${encodeURIComponent(runId)}/events`, event as unknown as Record<string, unknown>);
  }

  async completeFolderRun(runId: string): Promise<ApiResponse<FolderSource>> {
    return this.request('POST', `/api/v1/folder-sources/runs/${encodeURIComponent(runId)}/complete`, {});
  }

  async refreshFolderSource(sourceId: string, input: FolderRefreshRequest): Promise<ApiResponse<FolderSource>> {
    return this.request('POST', `/api/v1/folder-sources/${encodeURIComponent(sourceId)}/refresh`, input as unknown as Record<string, unknown>);
  }

  async prepareFolderRemoval(sourceId: string, retention: FolderRetention): Promise<ApiResponse<FolderSource>> {
    return this.request('POST', `/api/v1/folder-sources/${encodeURIComponent(sourceId)}/remove`, { retention });
  }

  async completeFolderRemoval(sourceId: string, input: FolderRemovalCompleteRequest): Promise<ApiResponse<FolderSource>> {
    return this.request('POST', `/api/v1/folder-sources/${encodeURIComponent(sourceId)}/remove/complete`, input as unknown as Record<string, unknown>);
  }

  async createOrganizationProposal(input: OrganizationProposalRequest): Promise<ApiResponse<OrganizationPlan>> {
    return this.request('POST', '/api/v1/organization-plans', input as unknown as Record<string, unknown>);
  }

  async listOrganizationPlans(): Promise<ApiResponse<OrganizationPlan[]>> {
    return this.request('GET', '/api/v1/organization-plans');
  }

  async getOrganizationPlan(planId: string): Promise<ApiResponse<OrganizationPlan>> {
    return this.request('GET', `/api/v1/organization-plans/${encodeURIComponent(planId)}`);
  }

  async applyOrganizationPlan(
    planId: string,
    decisions: OrganizationDecision[],
  ): Promise<ApiResponse<OrganizationPlan>> {
    return this.request('POST', `/api/v1/organization-plans/${encodeURIComponent(planId)}/apply`, { decisions });
  }

  async undoOrganizationPlan(planId: string): Promise<ApiResponse<OrganizationPlan>> {
    return this.request('POST', `/api/v1/organization-plans/${encodeURIComponent(planId)}/undo`, {});
  }

  async recallTutorialCapabilities(environment: 'native' | 'wsl'): Promise<ApiResponse<RecallClientCapability[]>> {
    return this.request('GET', `/api/v1/recall-tutorials/capabilities?environment=${environment}`);
  }

  async createRecallTutorial(input: RecallTutorialCreateRequest): Promise<ApiResponse<RecallTutorial>> {
    return this.request('POST', '/api/v1/recall-tutorials', input as unknown as Record<string, unknown>);
  }

  async listRecallTutorials(): Promise<ApiResponse<RecallTutorial[]>> {
    return this.request('GET', '/api/v1/recall-tutorials');
  }

  async getRecallTutorial(id: string): Promise<ApiResponse<RecallTutorial>> {
    return this.request('GET', `/api/v1/recall-tutorials/${encodeURIComponent(id)}`);
  }

  async checkRecallTutorial(id: string, reportedFailure?: RecallDiagnosticCode): Promise<ApiResponse<RecallTutorial>> {
    return this.request('POST', `/api/v1/recall-tutorials/${encodeURIComponent(id)}/check`,
      reportedFailure ? { reportedFailure } : {});
  }

  // Agent endpoints
  async getSchema(): Promise<ApiResponse<SchemaResponse>> {
    return this.request<SchemaResponse>('GET', '/api/v1/agent/schema');
  }

  async query(input: QueryInput): Promise<ApiResponse<QueryResult>> {
    return this.request<QueryResult>('POST', '/api/v1/agent/query', input as unknown as Record<string, unknown>);
  }

  async retrieve(input: RetrieveInput): Promise<ApiResponse<RetrieveResult>> {
    return this.request<RetrieveResult>('POST', '/api/v1/agent/retrieve', input as unknown as Record<string, unknown>);
  }

  async summarize(input: SummarizeInput): Promise<ApiResponse<SummarizeResult>> {
    return this.request<SummarizeResult>('POST', '/api/v1/agent/summarize', input as unknown as Record<string, unknown>);
  }

  async healthCheck(): Promise<HealthResponse> {
    const response = await fetch(`${this.apiUrl}/health`, {
      headers: { 'X-AE-Surface': 'cli', 'X-AE-Client': 'cli' },
    });
    if (!response.ok) {
      throw new ApiError(response.status, `HTTP_${response.status}`, `Health check failed: ${response.status}`);
    }
    const parsed = HealthResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new ApiError(
        502,
        'INVALID_HEALTH_RESPONSE',
        'Health check returned an invalid runtime channel identity',
      );
    }
    if (this.expectedChannel && parsed.data.channel !== this.expectedChannel) {
      throw new ApiError(
        409,
        'RUNTIME_CHANNEL_MISMATCH',
        `API reported ${parsed.data.channel}, expected ${this.expectedChannel}`,
      );
    }
    return parsed.data;
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
export type TextKind = 'raw' | 'cleaned' | 'synthesized' | 'structured' | 'compatibility';

export interface LibraryScope {
  type: 'library';
  libraryId: string;
  librarySlug: string;
  libraryName: string;
  itemCount: number;
}

export interface SchemaResponse {
  contentTypes: Record<string, number>;
  tags: Array<{ slug: string; label: string; description: string | null; category: string | null }>;
  capabilities: string[];
  dateRange: { earliest: string | null; latest: string | null };
}

export interface QueryInput {
  query: string;
  libraryId?: string;
  librarySlug?: string;
  searchType?: 'fulltext' | 'semantic' | 'hybrid';
  filters?: { contentTypes?: string[]; tags?: string[]; dateFrom?: string; dateTo?: string; status?: 'active' | 'archived' };
  include?: Array<'summary' | 'content' | 'metadata'>;
  limit?: number;
}

export interface QueryResultItem {
  id: string; contentType: string; title: string; summary?: string | null;
  content?: string | null; metadata?: Record<string, unknown>; textKind: TextKind;
  relevanceScore: number; createdAt: string;
}

export interface QueryResult { results: QueryResultItem[]; total: number; searchType: string; scope?: LibraryScope; }

export interface RetrieveInput {
  ids: string[];
  libraryId?: string;
  librarySlug?: string;
  include?: Array<'summary' | 'content' | 'metadata'>;
}

export interface RetrieveResultItem {
  id: string; contentType: string; title: string; summary?: string | null;
  content?: string | null; metadata?: Record<string, unknown>; textKind: TextKind;
  sourceUrl: string | null; createdAt: string; updatedAt: string;
}

export interface RetrieveResult { items: RetrieveResultItem[]; scope?: LibraryScope; }

export interface SummarizeInput { prompt: string; libraryId?: string; librarySlug?: string; filter?: { contentTypes?: string[]; tags?: string[]; dateFrom?: string; dateTo?: string }; limit?: number; }
export interface SummarizeResult { summary: string; sourceCount: number; prompt: string; scope?: LibraryScope; }
export interface HealthResponse { status: 'healthy'; uptime: number; channel: 'stable' | 'staging'; }

export type ImportItem = Record<string, unknown>;

export interface ImportRequest {
  items: ImportItem[];
  options?: Record<string, unknown>;
  libraryId?: string;
  librarySlug?: string;
}

export interface ImportParseError {
  rowIndex: number;
  col?: string;
  error: string;
}

export interface ImportPreviewResult {
  format?: 'csv' | 'json';
  fileName?: string;
  rowCount: number;
  sample: ImportItem[];
  parseErrors: ImportParseError[];
  requiresIdForIdempotency: boolean;
}

export interface ImportSubmitResult {
  status?: string;
  totalItems: number;
  requiresIdForIdempotency?: boolean;
  parseErrors?: ImportParseError[];
  contentIds?: string[];
  completedItems?: number;
  createdItems?: number;
  updatedItems?: number;
  duplicateItems?: number;
  failedItems?: number;
  items?: Array<{
    rowIndex: number;
    id: string;
    outcome?: 'created' | 'updated' | 'duplicate';
  }>;
  failures?: Array<{ rowIndex?: number; error?: string; reason?: string }>;
}

export type FirstImportSourceId = 'claude-code' | 'codex' | 'cowork';
export type FirstImportOutcome = 'pending' | 'imported' | 'duplicate' | 'failed' | 'skipped';

export interface FirstImportDiscoveryItem {
  fingerprint: string;
  sourcePath: string;
  byteSize: number;
  modifiedAt: string;
}

export interface FirstImportDiscoverySource {
  sourceId: FirstImportSourceId;
  label: string;
  paths: string[];
  estimatedCount: number;
  estimatedBytes: number;
  privacyPosture: string;
  exclusions: string[];
  availability: 'available' | 'not_found' | 'unsupported_platform' | 'unavailable';
  availabilityNote: string;
  items: FirstImportDiscoveryItem[];
}

export interface FirstImportDiscoveryRequest {
  manifestPath: string;
  sources: FirstImportDiscoverySource[];
}

export interface FirstImportSessionItem extends FirstImportDiscoveryItem {
  sourceId: FirstImportSourceId;
  outcome: FirstImportOutcome;
  contentIds: string[];
  archiveManifestPath: string | null;
  errorCode: string | null;
  recoveryAction: string | null;
}

export interface FirstImportSession {
  id: string;
  status: 'discovered' | 'approved' | 'running' | 'cancel_requested' | 'canceled' | 'completed' | 'failed';
  manifestPath: string;
  selectedSourceIds: FirstImportSourceId[];
  approvedAt: string | null;
  counts: { discovered: number; imported: number; duplicate: number; failed: number; skipped: number };
  pending: number;
  sources: Array<Omit<FirstImportDiscoverySource, 'items'> & {
    status: string; errorCode: string | null; recoveryAction: string | null;
  }>;
  items: FirstImportSessionItem[];
}

export interface FirstImportEventRequest {
  sourceId: FirstImportSourceId;
  fingerprint: string;
  outcome: Exclude<FirstImportOutcome, 'pending'>;
  contentIds?: string[];
  archiveManifestPath?: string;
  errorCode?: string;
  recoveryAction?: string;
}

export type FolderDisposition = 'candidate' | 'excluded' | 'hidden' | 'unsupported' | 'binary'
  | 'too_large' | 'access_denied' | 'symlink' | 'aggregate_limit' | 'missing';
export type FolderOutcome = 'pending' | 'imported' | 'updated' | 'duplicate' | 'excluded'
  | 'changed' | 'failed' | 'skipped' | 'missing';
export type FolderRetention = 'keep' | 'delete';

export interface FolderInventoryRequestItem {
  sourcePath: string; relativePath: string; fileType?: string; byteSize: number;
  modifiedAt?: string; disposition: FolderDisposition; reason: string;
  metadataFingerprint?: string; change?: 'added' | 'changed' | 'unchanged' | 'missing' | 'excluded';
}
export interface FolderSourceDiscoveryRequest {
  rootPath: string; libraryId?: string; includePatterns: string[]; excludePatterns: string[];
  maxFileBytes: number; maxTotalBytes: number; symlinkPolicy: 'no_follow'; manifestPath: string;
  inventory: FolderInventoryRequestItem[];
}
export interface FolderRefreshRequest { manifestPath: string; inventory: FolderInventoryRequestItem[]; }
export interface FolderIngestionEventRequest {
  relativePath: string; outcome: Exclude<FolderOutcome, 'pending'>; appliedSha256?: string;
  contentId?: string; archiveManifestPath?: string; errorCode?: string; recoveryAction?: string;
}
export interface FolderRun {
  id: string; sourceId: string; kind: 'initial' | 'refresh' | 'removal';
  status: 'previewed' | 'approved' | 'running' | 'cancel_requested' | 'canceled' | 'completed' | 'failed';
  manifestPath: string; approvedAt: string | null; inventoryCounts: Record<string, number>;
  counts: Record<FolderOutcome | 'previewed', number>;
  items: Array<FolderInventoryRequestItem & { outcome: FolderOutcome; appliedSha256: string | null;
    contentId: string | null; archiveManifestPath: string | null; errorCode: string | null; recoveryAction: string | null }>;
}
export interface FolderSource {
  id: string; rootPath: string; libraryId: string | null; includePatterns: string[]; excludePatterns: string[];
  maxFileBytes: number; maxTotalBytes: number; symlinkPolicy: 'no_follow'; manifestPath: string;
  status: 'previewed' | 'approved' | 'active' | 'paused' | 'removal_pending' | 'removed';
  retention: FolderRetention | null; approvedAt: string | null; removedAt: string | null;
  runs: FolderRun[]; latestRun: FolderRun | null;
}
export interface FolderRemovalCompleteRequest {
  retention: FolderRetention; deletedContentIds: string[]; archivesRemoved: number;
  failures: Array<{ path: string; errorCode: string }>;
}

export type OrganizationSuggestion = {
  id: string;
  confidence: number;
  rationale: string;
  evidence: Array<{ contentId: string; title: string; source: string }>;
  dependsOn: string[];
} & (
  | { type: 'tag.create'; tag: { slug: string; label: string; description: string | null; category: string | null; color: string | null } }
  | { type: 'tag.assign'; tagSlug: string; contentIds: string[] }
  | { type: 'library.create'; library: { slug: string; name: string; description: string | null; filter: Record<string, unknown> | null } }
);
export interface OrganizationDecision { suggestionId: string; decision: 'accept' | 'reject' }
export interface OrganizationProposalRequest { useModel: boolean; limit: number }
export interface OrganizationPlan {
  id: string;
  status: 'preview' | 'applied' | 'undone';
  proposalMode: 'local' | 'model';
  sampleLimit: number;
  sampleCount: number;
  sourceSnapshotSha256: string;
  proposalSha256: string;
  suggestions: OrganizationSuggestion[];
  decisions: OrganizationDecision[] | null;
  applyResult: Array<Record<string, unknown>> | null;
  modelProvider: string | null;
  modelId: string | null;
  appliedAt: string | null;
  undoneAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RecallTutorialClient = 'codex' | 'chatgpt-desktop' | 'chatgpt-work' | 'chatgpt-web' | 'claude-code' | 'claude-desktop' | 'claude-cowork' | 'cursor' | 'cli';
export type RecallDiagnosticCode = 'runtime' | 'wiring' | 'access' | 'indexing' | 'retrieval';
export interface RecallClientCapability { id: RecallTutorialClient; label: string; supported: boolean; verification: 'command' | 'guided' | 'unavailable'; surface: 'mcp' | 'cli'; limitation?: string }
export interface RecallTutorialCreateRequest { writeClient: RecallTutorialClient; recallClient: RecallTutorialClient; environment: 'native' | 'wsl' }
export interface RecallTutorial {
  id: string; status: 'planned' | 'remembered' | 'verified'; writeClient: RecallTutorialClient;
  recallClient: RecallTutorialClient; sameClient: boolean; marker: string; fact: string;
  sourceIdentifier: string; contentId: string | null;
  diagnostic: { code: string; details: Record<string, unknown> };
  instructions: { remember: { client: RecallTutorialClient; text: string }; freshChat: { client: RecallTutorialClient; answerBearingContextIncluded: false; text: string } };
  rememberedAt: string | null; verifiedAt: string | null; createdAt: string; updatedAt: string;
}
