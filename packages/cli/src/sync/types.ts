import type { ImportItem } from '../api-client.js';
import type { Conversation } from './interchange.js';

export const SUPPORTED_TRANSCRIPT_SOURCES = ['claude-code', 'codex', 'cowork'] as const;
export const LOCAL_DIR_SOURCE_ID = 'local_dir' as const;
export const SUPPORTED_SYNC_SOURCES = [
  ...SUPPORTED_TRANSCRIPT_SOURCES,
  LOCAL_DIR_SOURCE_ID,
] as const;
export const DEFAULT_LOCAL_DIR_MAX_FILE_BYTES = 5 * 1024 * 1024;

export type TranscriptSourceId = typeof SUPPORTED_TRANSCRIPT_SOURCES[number];
export type SourceType = typeof SUPPORTED_SYNC_SOURCES[number];

export function isTranscriptSourceId(value: string): value is TranscriptSourceId {
  return (SUPPORTED_TRANSCRIPT_SOURCES as readonly string[]).includes(value);
}

export function isSourceType(value: string): value is SourceType {
  return (SUPPORTED_SYNC_SOURCES as readonly string[]).includes(value);
}

export type ChatTurnRole = 'user' | 'assistant' | 'system' | 'tool' | 'developer' | 'other';

export interface TranscriptFile {
  path: string;
  sourceId: TranscriptSourceId;
  identity?: string;
  size: number;
  mtimeMs: number;
}

export interface FileCursor {
  offset: number;
  line: number;
  importedCount: number;
  skippedCount: number;
  fileSize: number;
  lastMtimeMs: number;
  fileIdentity?: string;
  sourceSha256?: string;
  lastImportedSourceIdentifier?: string;
  contentId?: string;
  updatedAt?: string;
}

export interface TranscriptCursorStoreData {
  version: 1;
  files: Record<string, FileCursor>;
}

export interface ChatTurn {
  sourceId: TranscriptSourceId;
  sourceName: string;
  sourceAgentId: 'claude';
  sourceAgentLabel: string;
  filePath: string;
  fileIdentity?: string;
  sourceSha256?: string;
  adapterName?: string;
  adapterVersion?: string;
  conversationId: string;
  turnIndex: number;
  turnKey: string;
  sourceIdentifier: string;
  role: ChatTurnRole;
  timestamp?: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface TranscriptReadError {
  filePath: string;
  line: number;
  message: string;
}

export interface TranscriptReadResult {
  turns: ChatTurn[];
  nextCursor: FileCursor;
  errors: TranscriptReadError[];
  processedLines: number;
}

export interface ConversationReadResult {
  conversations: Conversation[];
  errors: TranscriptReadError[];
  processedLines: number;
  sourceFingerprint: string;
}

export interface TranscriptDiscoverOptions {
  paths?: string[];
  inventoryOnly?: boolean;
}

export interface TranscriptSource {
  id: TranscriptSourceId;
  label: string;
  discover(options?: TranscriptDiscoverOptions): Promise<TranscriptFile[]>;
  readNewTurns?(file: TranscriptFile, cursor: FileCursor): Promise<TranscriptReadResult>;
  fingerprint?(file: TranscriptFile): Promise<string>;
  readConversations?(file: TranscriptFile): Promise<ConversationReadResult>;
}

export interface DocumentFile {
  path: string;
  rootPath: string;
  relativePath: string;
  sourceId: typeof LOCAL_DIR_SOURCE_ID;
  identity?: string;
  size: number;
  mtimeMs: number;
}

export interface DocumentImportRow {
  filePath: string;
  fileIdentity?: string;
  relativePath: string;
  sourceIdentifier: string;
  sourceSha256: string;
  adapterName: string;
  adapterVersion: string;
  title: string;
  contentType: 'document';
  content?: string;
  raw: Record<string, unknown>;
}

export interface DocumentReadResult {
  documents: DocumentImportRow[];
  sourceFingerprint: string;
}

export type LocalDirSkipReason = 'binary' | 'too_large';

export interface LocalDirSkip {
  path: string;
  reason: LocalDirSkipReason;
  size: number;
  maxFileBytes: number;
}

export interface LocalDirDiscoverOptions {
  paths: string[];
  include?: string[];
  exclude?: string[];
  maxFileBytes?: number;
  onSkip?: (event: LocalDirSkip) => void;
}

export interface LocalDirSource {
  id: typeof LOCAL_DIR_SOURCE_ID;
  label: string;
  discover(options: LocalDirDiscoverOptions): Promise<DocumentFile[]>;
  readDocuments(file: DocumentFile, contentType: 'document'): Promise<DocumentReadResult>;
}

export interface NormalizedChatImportRow extends ImportItem {
  title: string;
  content_type: 'chat';
  source_identifier: string;
  content: string;
  source: string;
  source_agent_id: 'claude';
  conversation_id: string;
  turn_index: number;
  turn_role: ChatTurnRole;
  turn_timestamp?: string;
  turn_metadata: Record<string, unknown>;
}

/**
 * Canonical contract for new history adapters. The legacy flat turn interfaces
 * above remain until the Claude Code adapter migrates in #916.
 */
export {
  ADAPTER_INTERCHANGE_VERSION,
  CHAT_INTERCHANGE_VERSION,
  ChatHistoryInterchangeSchema,
  ChatProviderSchema,
  ChatSurfaceSchema,
  ContentBlockSchema,
  ContentBlockTypeSchema,
  ConversationSchema,
  EventCategorySchema,
  EventRoleSchema,
  EventSchema,
  RelationSchema,
  RelationTypeSchema,
} from './interchange.js';
export type {
  ChatHistoryInterchange,
  ChatProvider,
  ChatSurface,
  ContentBlock,
  Conversation,
  Event,
  Relation,
} from './interchange.js';
