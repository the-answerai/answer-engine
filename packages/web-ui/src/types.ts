export const CONTENT_TYPES = ['call', 'document', 'ticket', 'domain', 'chat', 'page'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];
export type ContentStatus = 'active' | 'archived';
export type ContentSort = 'createdAt' | 'title' | 'contentType' | 'source' | 'status';

export interface Tag {
  id: string;
  slug: string;
  label: string;
  description: string | null;
  category: string | null;
  parentId: string | null;
  color: string | null;
  metadata: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ContentTag extends Pick<Tag, 'id' | 'slug' | 'label' | 'category' | 'color'> {
  confidence: number | null;
}

export interface ContentItem {
  id: string;
  contentType: ContentType;
  title: string;
  summary?: string | null;
  content?: string | null;
  source?: string;
  sourceIdentifier?: string;
  status?: ContentStatus;
  tags?: ContentTag[];
  metadata?: Record<string, unknown>;
  sourceData?: Record<string, unknown>;
  analysisData?: Record<string, unknown>;
  rawArchiveManifest?: Record<string, unknown> | null;
  textKind?: string;
  sourceUrl?: string | null;
  sourceAgentId?: string | null;
  conversationId?: string | null;
  turnIndex?: number | null;
  turnRole?: string | null;
  turnTimestamp?: string | null;
  turnMetadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  score?: number;
  relevanceScore?: number;
}

export interface PageMeta {
  hasMore: boolean;
  nextCursor: string | null;
  total: number;
}

export interface ContentFilters {
  search?: string;
  contentTypes?: ContentType[];
  sources?: string[];
  tags?: string[];
  status?: ContentStatus;
  dateFrom?: string;
  dateTo?: string;
  libraryId?: string;
  sortBy?: ContentSort;
  sortDirection?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
}

export interface ContentPageResult {
  items: ContentItem[];
  meta: PageMeta;
}

export interface Artifact {
  id: string;
  contentId: string;
  artifactType: string;
  textContent: string | null;
  dataJson: Record<string, unknown> | null;
  status: string;
  version: number;
  isCurrent: boolean;
  modelId: string | null;
  sourceContentIds?: string[];
  supersedesId?: string | null;
  recipeId?: string | null;
  recipeRunId?: string | null;
  recipeVersion?: string | null;
  promptHash?: string | null;
  metadata?: Record<string, unknown>;
  updatedAt?: string;
  createdAt: string;
}

export interface LocalSettings {
  defaultPageSize: number;
  defaultLibraryId: string | null;
  density: 'comfortable' | 'compact';
  defaultExportFormat: 'json' | 'csv' | 'markdown';
}

export type WorkStatus = 'queued' | 'running' | 'succeeded' | 'partial_success' | 'failed' | 'canceled';

export interface Recipe {
  id: string;
  libraryId: string;
  name: string;
  description: string | null;
  contentTypes: ContentType[];
  systemPrompt: string;
  userPromptTemplate: string;
  outputType: string;
  outputSchema: Record<string, unknown> | null;
  modelId: string | null;
  maxTokens: number | null;
  isActive: boolean;
  currentVersion: number;
  promptHash: string;
  createdAt: string;
  updatedAt: string;
}

export type RecipeInput = Pick<Recipe, 'name' | 'contentTypes' | 'systemPrompt' | 'userPromptTemplate' | 'outputType'> & {
  description?: string | null;
  outputSchema?: Record<string, unknown> | null;
  modelId?: string | null;
  maxTokens?: number | null;
  isActive?: boolean;
};

export interface RecipePreviewItem {
  contentId: string;
  title: string;
  output: string;
  outputData?: unknown;
  modelId?: string;
  provider?: string;
}

export interface RecipeRunItem {
  id: string;
  contentId: string;
  artifactId: string | null;
  status: string;
  outputPreview: string | null;
  outputData: unknown;
  errorMessage: string | null;
  createdAt: string;
}

export interface RecipeRun {
  id: string;
  libraryId: string;
  recipeId: string;
  recipeVersion: number;
  status: WorkStatus;
  totalCount: number;
  processedCount: number;
  succeededCount: number;
  skippedCount: number;
  failedCount: number;
  errorMessage?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  items?: RecipeRunItem[];
}

export interface ReportDefinition {
  id: string;
  libraryId: string;
  title: string;
  slug: string;
  description: string | null;
  prompt: string;
  schedule: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ReportInput = Pick<ReportDefinition, 'title' | 'slug' | 'prompt'> & {
  description?: string | null;
  schedule?: string | null;
  isActive?: boolean;
};

export interface GeneratedReport {
  id: string;
  libraryId: string;
  reportId: string;
  status: WorkStatus;
  title: string;
  body: string | null;
  sourceContentIds: string[];
  modelId: string | null;
  errorMessage: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardLayoutItem {
  widgetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DashboardWidget {
  id: string;
  type: 'metric' | 'markdown' | 'report' | 'recent_content';
  title: string;
  config: { value?: string; body?: string; reportId?: string; limit?: number };
}

export interface Dashboard {
  id: string;
  libraryId: string;
  name: string;
  description: string | null;
  layout: DashboardLayoutItem[];
  widgets: DashboardWidget[];
  createdAt: string;
  updatedAt: string;
}

export interface BatchResult {
  id: string;
  contentId: string;
  status: string;
  output: unknown;
  errorMessage: string | null;
  createdAt: string;
}

export interface BatchJob {
  id: string;
  libraryId: string | null;
  kind: 'prompt' | 'export' | 'import';
  name: string;
  status: WorkStatus;
  input: Record<string, unknown>;
  totalCount: number;
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  errorMessage?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  results?: BatchResult[];
}

export interface CursorPage<T> {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface AccessToken {
  id: string;
  libraryId: string | null;
  keyPrefix: string;
  name: string;
  description: string | null;
  capabilities: Array<'read' | 'write'>;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  isCurrent?: boolean;
  isProtected?: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface MintedAccessToken extends AccessToken {
  token: string;
}

export interface AuditEntry {
  id: string;
  libraryId: string | null;
  apiKeyId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  outcome: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ContentBlob {
  id: string;
  contentId: string;
  fileName: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  sourceMetadata: Record<string, unknown>;
  createdAt: string;
}

export interface LineageResult {
  source?: string;
  origin?: {
    sourceUrl?: string | null;
    externalId?: string;
    rawArchiveManifest?: Record<string, unknown> | null;
  };
  currentArtifacts?: Artifact[];
  lineage?: Array<{ artifactType: string; versions: Artifact[] }>;
  [key: string]: unknown;
}

export interface Citation {
  contentId?: string;
  id?: string;
  title?: string;
  contentType?: string;
  excerpt?: string;
  source?: string;
  relevanceScore?: number;
}

export interface AskResult {
  answer: string;
  citations: Citation[];
  modelId?: string;
  provider?: string;
}

export interface FilterCondition {
  field: 'content_type' | 'source' | 'created_at' | 'tag' | `metadata.${string}` | `analysis.${string}`;
  operator: 'eq' | 'in' | 'contains' | 'gte' | 'lte';
  value: string | number | boolean | Array<string | number | boolean>;
}

export interface LibraryFilter {
  operator: 'and' | 'or';
  conditions: FilterCondition[];
}

export interface Library {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  kind: 'system_all_content' | 'user_defined';
  filter: LibraryFilter | null;
  metadata: Record<string, unknown>;
  isActive: boolean;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryMember {
  id: string;
  title: string;
  contentType: ContentType;
  source: string;
  summary: string | null;
  createdAt: string;
}

export interface LibraryMemberPage {
  items: LibraryMember[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ImportItem {
  title: string;
  content?: string;
  contentType?: ContentType;
  content_type?: ContentType;
  source?: string;
  sourceIdentifier?: string;
  source_identifier?: string;
  metadata?: Record<string, unknown>;
  sourceData?: Record<string, unknown>;
  source_data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ImportPreview {
  format: string;
  rowCount: number;
  sample: ImportItem[];
  parseErrors: string[];
}

export interface ImportResult {
  completedItems: number;
  createdItems?: number;
  updatedItems?: number;
  duplicateItems?: number;
  failedItems: number;
  items: Array<{ rowIndex: number; id: string; contentType: string; sourceIdentifier: string; title: string; outcome?: 'created' | 'updated' | 'duplicate' }>;
  failures: Array<{ rowIndex: number; sourceIdentifier: string; error: string }>;
}

export type FirstImportSourceId = 'claude-code' | 'codex' | 'cowork';
export type FirstImportStatus = 'discovered' | 'approved' | 'running' | 'cancel_requested' | 'canceled' | 'completed' | 'failed';

export interface FirstImportSession {
  id: string;
  status: FirstImportStatus;
  selectedSourceIds: FirstImportSourceId[];
  approvedAt: string | null;
  pending: number;
  counts: { discovered: number; imported: number; duplicate: number; failed: number; skipped: number };
  sources: Array<{
    sourceId: FirstImportSourceId;
    label: string;
    paths: string[];
    estimatedCount: number;
    estimatedBytes: number;
    privacyPosture: string;
    exclusions: string[];
    availability: 'available' | 'not_found' | 'unsupported_platform' | 'unavailable';
    availabilityNote: string;
    status: string;
    errorCode: string | null;
    recoveryAction: string | null;
  }>;
}
