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
      headers: { 'X-AE-Surface': 'cli' },
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
  failedItems?: number;
  failures?: Array<{ rowIndex?: number; error?: string; reason?: string }>;
}
