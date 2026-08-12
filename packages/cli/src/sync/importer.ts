import type { AnswerEngineClient, ImportItem, ImportRequest } from '../api-client.js';
import {
  CHAT_INTERCHANGE_VERSION,
  type Conversation,
  type ContentBlock,
  type Event,
} from './interchange.js';
import type {
  ChatTurn,
  DocumentImportRow,
  NormalizedChatImportRow,
} from './types.js';

export interface SyncImportOptions {
  client: Pick<AnswerEngineClient, 'submitSyncImport'>;
  batchSize: number;
  libraryId?: string;
  librarySlug?: string;
}

export interface SyncImportSummary {
  requestedItems: number;
  importedItems: number;
  failedItems: number;
  contentIds: string[];
  failures: Array<{ rowIndex?: number; error?: string; reason?: string }>;
}

export interface ConversationImportRow extends ImportItem {
  title: string;
  content_type: 'chat';
  source_identifier: string;
  content?: string;
  source: 'claude-code' | 'codex' | 'cowork' | 'claude-cloud-export';
  source_agent_id: 'claude' | 'codex';
  conversation_id: string;
}

export interface NormalizedDocumentImportRow extends ImportItem {
  title: string;
  content_type: 'document';
  source_identifier: string;
  source: 'local_dir';
  content?: string;
}

// Mirror of the server's MAX_CONTENT_CHARS (src/config/content-limits.ts). The
// derived `content` search projection must stay within the ingest cap so a
// large conversation is never rejected at the API boundary; full fidelity is
// preserved separately in source_data.chat_interchange + the raw archive.
const MAX_DERIVED_CONTENT_CHARS = 5 * 1024 * 1024;

const SOURCE_BY_SURFACE: Record<Conversation['surface'], ConversationImportRow['source']> = {
  codex: 'codex',
  claude_code: 'claude-code',
  claude_cowork: 'cowork',
  claude_cloud_export: 'claude-cloud-export',
};

function stringifyJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function blockSearchText(block: ContentBlock): string | undefined {
  if (block.block_type === 'encrypted' || block.block_type === 'opaque') return undefined;
  if (block.text?.trim()) return block.text.trim();
  if (block.uri_or_path) return block.uri_or_path;
  if (block.tool_name && block.json_payload !== undefined) {
    const payload = stringifyJson(block.json_payload);
    return payload ? `${block.tool_name}: ${payload}` : block.tool_name;
  }
  if (block.json_payload !== undefined) return stringifyJson(block.json_payload);
  return undefined;
}

function eventSearchText(event: Event): string | undefined {
  const content = [...event.content_blocks]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map(blockSearchText)
    .filter((value): value is string => Boolean(value))
    .join('\n');
  if (!content) return undefined;
  return `[${event.role ?? event.category}] ${content}`;
}

export function conversationSearchText(conversation: Conversation): string | undefined {
  const content = [...conversation.events]
    .sort((left, right) => left.sequence - right.sequence)
    .map(eventSearchText)
    .filter((value): value is string => Boolean(value))
    .join('\n\n');
  if (!content) return undefined;
  return content.length > MAX_DERIVED_CONTENT_CHARS
    ? content.slice(0, MAX_DERIVED_CONTENT_CHARS)
    : content;
}

export function conversationToImportRow(conversation: Conversation): ConversationImportRow {
  const source = SOURCE_BY_SURFACE[conversation.surface];
  const title = conversation.title ?? `${source} conversation ${conversation.source_conversation_id}`;
  const content = conversationSearchText(conversation);

  return {
    title,
    content_type: 'chat',
    source_identifier: `${conversation.provider}:${conversation.surface}:${conversation.source_conversation_id}`,
    ...(content ? { content } : {}),
    source,
    source_agent_id: conversation.provider === 'openai_codex' ? 'codex' : 'claude',
    conversation_id: conversation.source_conversation_id,
    'metadata.sync.source': source,
    'metadata.sync.source_path': conversation.source_path,
    'metadata.sync.source_sha256': conversation.source_sha256,
    'metadata.sync.adapter_name': conversation.adapter_name,
    'metadata.sync.adapter_version': conversation.adapter_version,
    'metadata.sync.archived': conversation.archived,
    'metadata.chat_interchange.provider': conversation.provider,
    'metadata.chat_interchange.surface': conversation.surface,
    'metadata.chat_interchange.parent_source_conversation_id': conversation.parent_source_conversation_id,
    'metadata.chat_interchange.created_at': conversation.created_at,
    'metadata.chat_interchange.created_at_original': conversation.created_at_original,
    'metadata.chat_interchange.updated_at': conversation.updated_at,
    'metadata.chat_interchange.updated_at_original': conversation.updated_at_original,
    'metadata.chat_interchange.cwd': conversation.cwd,
    'metadata.chat_interchange.model': conversation.model,
    'metadata.chat_interchange.reasoning_effort': conversation.reasoning_effort,
    'metadata.provider_metadata_json': conversation.provider_metadata_json,
    'source_data.chat_interchange': {
      interchange_version: CHAT_INTERCHANGE_VERSION,
      events: conversation.events,
      relations: conversation.relations,
    },
  };
}

export function conversationToImportRows(
  conversations: readonly Conversation[],
): ConversationImportRow[] {
  return conversations.map(conversationToImportRow);
}

export function turnToImportRow(turn: ChatTurn): NormalizedChatImportRow {
  return {
    title: turn.title,
    content_type: 'chat',
    source_identifier: turn.sourceIdentifier,
    content: turn.content,
    source: turn.sourceId,
    source_agent_id: turn.sourceAgentId,
    conversation_id: turn.conversationId,
    turn_index: turn.turnIndex,
    turn_role: turn.role,
    ...(turn.timestamp ? { turn_timestamp: turn.timestamp } : {}),
    turn_metadata: turn.metadata,
    'metadata.sync.source': turn.sourceId,
    'metadata.sync.source_name': turn.sourceName,
    'metadata.sync.file_path': turn.filePath,
    'metadata.sync.file_identity': turn.fileIdentity,
    'metadata.sync.source_sha256': turn.sourceSha256,
    'metadata.sync.adapter_name': turn.adapterName,
    'metadata.sync.adapter_version': turn.adapterVersion,
    'metadata.sync.turn_key': turn.turnKey,
    'source_data.raw_record': turn.raw,
  };
}

export function documentToImportRow(document: DocumentImportRow): NormalizedDocumentImportRow {
  return {
    title: document.title,
    content_type: document.contentType,
    source_identifier: document.sourceIdentifier,
    source: 'local_dir',
    ...(document.content !== undefined ? { content: document.content } : {}),
    'metadata.sync.source': 'local_dir',
    'metadata.sync.source_path': document.filePath,
    'metadata.sync.file_identity': document.fileIdentity,
    'metadata.sync.source_sha256': document.sourceSha256,
    'metadata.sync.adapter_name': document.adapterName,
    'metadata.sync.adapter_version': document.adapterVersion,
    'source_data.raw': document.raw,
  };
}

function buildRequest(
  items: ImportItem[],
  options: Pick<SyncImportOptions, 'libraryId' | 'librarySlug'>
): ImportRequest {
  return {
    items,
    ...(options.libraryId ? { libraryId: options.libraryId } : {}),
    ...(options.librarySlug ? { librarySlug: options.librarySlug } : {}),
  };
}

export async function importTurns(
  turns: ChatTurn[],
  options: SyncImportOptions
): Promise<SyncImportSummary> {
  const summary: SyncImportSummary = {
    requestedItems: turns.length,
    importedItems: 0,
    failedItems: 0,
    contentIds: [],
    failures: [],
  };

  for (let start = 0; start < turns.length; start += options.batchSize) {
    const batch = turns.slice(start, start + options.batchSize);
    const response = await options.client.submitSyncImport(
      buildRequest(batch.map(turnToImportRow), options),
    );
    const data = response.data;
    summary.importedItems += data.completedItems ?? data.contentIds?.length ?? batch.length;
    summary.failedItems += data.failedItems ?? data.failures?.length ?? 0;
    if (data.contentIds?.length) summary.contentIds.push(...data.contentIds);
    if (data.failures?.length) summary.failures.push(...data.failures);
  }

  return summary;
}

export async function importConversations(
  conversations: readonly Conversation[],
  options: SyncImportOptions,
): Promise<SyncImportSummary> {
  const summary: SyncImportSummary = {
    requestedItems: conversations.length,
    importedItems: 0,
    failedItems: 0,
    contentIds: [],
    failures: [],
  };

  for (let start = 0; start < conversations.length; start += options.batchSize) {
    const batch = conversationToImportRows(
      conversations.slice(start, start + options.batchSize),
    );
    const response = await options.client.submitSyncImport(buildRequest(batch, options));
    const data = response.data;
    summary.importedItems += data.completedItems ?? data.contentIds?.length ?? batch.length;
    summary.failedItems += data.failedItems ?? data.failures?.length ?? 0;
    if (data.contentIds?.length) summary.contentIds.push(...data.contentIds);
    if (data.failures?.length) summary.failures.push(...data.failures);
  }

  return summary;
}

export async function importDocuments(
  documents: readonly DocumentImportRow[],
  options: SyncImportOptions,
): Promise<SyncImportSummary> {
  const summary: SyncImportSummary = {
    requestedItems: documents.length,
    importedItems: 0,
    failedItems: 0,
    contentIds: [],
    failures: [],
  };

  for (let start = 0; start < documents.length; start += options.batchSize) {
    const batch = documents.slice(start, start + options.batchSize).map(documentToImportRow);
    const response = await options.client.submitSyncImport(buildRequest(batch, options));
    const data = response.data;
    summary.importedItems += data.completedItems ?? data.contentIds?.length ?? batch.length;
    summary.failedItems += data.failedItems ?? data.failures?.length ?? 0;
    if (data.contentIds?.length) summary.contentIds.push(...data.contentIds);
    if (data.failures?.length) summary.failures.push(...data.failures);
  }

  return summary;
}
