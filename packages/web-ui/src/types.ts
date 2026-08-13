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
  failedItems: number;
  items: Array<{ rowIndex: number; id: string; contentType: string; sourceIdentifier: string; title: string }>;
  failures: Array<{ rowIndex: number; sourceIdentifier: string; error: string }>;
}
