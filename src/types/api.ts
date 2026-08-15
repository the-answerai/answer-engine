export type ContentType = 'call' | 'document' | 'ticket' | 'domain' | 'chat' | 'page';
export type SearchType = 'fulltext' | 'semantic' | 'hybrid';

export interface Principal {
  tenantId: string;
  apiKeyId: string;
  libraryId?: string;
  surface?: 'mcp' | 'cli' | 'cli-sync' | 'browser' | 'api';
  client?: 'codex' | 'chatgpt-desktop' | 'claude-code' | 'claude-desktop' | 'cursor' | 'cli';
}

export interface LibraryScope {
  type: 'library';
  libraryId: string;
  librarySlug: string;
  libraryName: string;
  itemCount: number;
  filterPredicate: import('../services/library/library-membership.js').LibraryFilter | null;
}

export interface ContentRow {
  id: string;
  tenant_id: string;
  library_id: string | null;
  content_type: ContentType;
  source: string;
  source_identifier: string;
  title: string;
  content: string | null;
  summary: string | null;
  source_data: Record<string, unknown>;
  metadata: Record<string, unknown>;
  analysis_data: Record<string, unknown>;
  raw_archive_manifest: Record<string, unknown> | null;
  external_url: string | null;
  primary_text_kind: string | null;
  source_agent_id: string | null;
  conversation_id: string | null;
  turn_index: number | null;
  turn_role: string | null;
  turn_timestamp: Date | null;
  turn_metadata: Record<string, unknown> | null;
  status: 'active' | 'archived' | 'deleted';
  tags?: Array<{
    id: string;
    slug: string;
    label: string;
    category: string | null;
    color: string | null;
    confidence: number | null;
  }>;
  total_count?: string;
  created_at: Date;
  updated_at: Date;
  relevance_score?: number;
}
