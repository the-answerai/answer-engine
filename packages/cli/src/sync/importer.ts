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
  createdItems: number;
  updatedItems: number;
  duplicateItems: number;
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

const MAX_TITLE_CHARS = 500;
// Keep the searchable projection comfortably below HTTP, embedding-model, and
// PostgreSQL text-search limits. The byte-exact source remains in the raw
// archive and the normalized event projection links back to it.
const MAX_DERIVED_CONTENT_CHARS = 512 * 1024;
const MAX_PROJECTED_EVENTS = 4_000;
const MAX_PROJECTED_BLOCK_TEXT_CHARS = 512;

const SOURCE_BY_SURFACE: Record<Conversation['surface'], ConversationImportRow['source']> = {
  codex: 'codex',
  claude_code: 'claude-code',
  claude_cowork: 'cowork',
  claude_cloud_export: 'claude-cloud-export',
};

function sanitizePostgresText<T>(value: T): T {
  if (typeof value === 'string') {
    let sanitized = '';
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code === 0) {
        sanitized += '\uFFFD';
        continue;
      }
      if (code >= 0xD800 && code <= 0xDBFF) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) {
          sanitized += value[index] + value[index + 1];
          index += 1;
        } else {
          sanitized += '\uFFFD';
        }
        continue;
      }
      if (code >= 0xDC00 && code <= 0xDFFF) {
        sanitized += '\uFFFD';
        continue;
      }
      sanitized += value[index];
    }
    return sanitized as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizePostgresText(entry)) as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizePostgresText(entry)]),
    ) as T;
  }
  return value;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rawArchiveManifest(conversation: Conversation): Record<string, unknown> | undefined {
  const manifest = conversation.provider_metadata_json.raw_archive_manifest;
  return isRecord(manifest) ? manifest : undefined;
}

function archiveReference(
  conversation: Conversation,
  event: Event,
  blockOrdinal?: number,
): Record<string, unknown> {
  const manifest = rawArchiveManifest(conversation);
  return {
    source_path: conversation.source_path,
    source_sha256: conversation.source_sha256,
    source_event_id: event.source_event_id,
    ...(blockOrdinal === undefined ? {} : { block_ordinal: blockOrdinal }),
    ...(typeof manifest?.manifest_path === 'string'
      ? { manifest_path: manifest.manifest_path }
      : {}),
  };
}

function projectEvent(conversation: Conversation, event: Event): Record<string, unknown> {
  return {
    sequence: event.sequence,
    source_event_id: event.source_event_id,
    ...(event.parent_event_id ? { parent_event_id: event.parent_event_id } : {}),
    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    ...(event.timestamp_original ? { timestamp_original: event.timestamp_original } : {}),
    category: event.category,
    role: event.role,
    provider_type: event.provider_type,
    ...(event.provider_subtype ? { provider_subtype: event.provider_subtype } : {}),
    raw_json: { raw_archive_ref: archiveReference(conversation, event) },
    content_blocks: event.content_blocks.map((block) => {
      const exposeText = block.block_type !== 'thinking'
        && block.block_type !== 'encrypted'
        && block.block_type !== 'opaque';
      const text = exposeText && block.text
        ? block.text.slice(0, MAX_PROJECTED_BLOCK_TEXT_CHARS)
        : undefined;
      const requiresArchiveReference = block.json_payload !== undefined
        || block.text !== text;
      return {
        ordinal: block.ordinal,
        block_type: block.block_type,
        ...(text ? { text } : {}),
        ...(block.mime_type ? { mime_type: block.mime_type } : {}),
        ...(block.uri_or_path ? { uri_or_path: block.uri_or_path } : {}),
        ...(block.tool_call_id ? { tool_call_id: block.tool_call_id } : {}),
        ...(block.tool_name ? { tool_name: block.tool_name } : {}),
        ...(block.is_error === undefined ? {} : { is_error: block.is_error }),
        ...(requiresArchiveReference
          ? { raw_archive_ref: archiveReference(conversation, event, block.ordinal) }
          : {}),
      };
    }),
  };
}

function projectedEvents(conversation: Conversation): Array<Record<string, unknown>> {
  if (conversation.events.length <= MAX_PROJECTED_EVENTS) {
    return conversation.events.map((event) => projectEvent(conversation, event));
  }
  const half = MAX_PROJECTED_EVENTS / 2;
  return [
    ...conversation.events.slice(0, half),
    ...conversation.events.slice(-half),
  ].map((event) => projectEvent(conversation, event));
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
  const title = (conversation.title ?? `${source} conversation ${conversation.source_conversation_id}`)
    .slice(0, MAX_TITLE_CHARS);
  const content = conversationSearchText(conversation);
  const manifest = rawArchiveManifest(conversation);
  const events = projectedEvents(conversation);

  return sanitizePostgresText({
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
      event_count: conversation.events.length,
      projected_event_count: events.length,
      omitted_event_count: conversation.events.length - events.length,
      events,
      relations: conversation.relations,
    },
    ...(manifest ? { raw_archive_manifest: manifest } : {}),
  });
}

export function conversationToImportRows(
  conversations: readonly Conversation[],
): ConversationImportRow[] {
  return conversations.map(conversationToImportRow);
}

export function turnToImportRow(turn: ChatTurn): NormalizedChatImportRow {
  return sanitizePostgresText({
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
  });
}

export function documentToImportRow(document: DocumentImportRow): NormalizedDocumentImportRow {
  return sanitizePostgresText({
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
  });
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
    createdItems: 0,
    updatedItems: 0,
    duplicateItems: 0,
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
    summary.createdItems += data.createdItems ?? data.items?.filter((item) => item.outcome === 'created').length ?? 0;
    summary.updatedItems += data.updatedItems ?? data.items?.filter((item) => item.outcome === 'updated').length ?? 0;
    summary.duplicateItems += data.duplicateItems ?? data.items?.filter((item) => item.outcome === 'duplicate').length ?? 0;
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
    createdItems: 0,
    updatedItems: 0,
    duplicateItems: 0,
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
    summary.createdItems += data.createdItems ?? data.items?.filter((item) => item.outcome === 'created').length ?? 0;
    summary.updatedItems += data.updatedItems ?? data.items?.filter((item) => item.outcome === 'updated').length ?? 0;
    summary.duplicateItems += data.duplicateItems ?? data.items?.filter((item) => item.outcome === 'duplicate').length ?? 0;
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
    createdItems: 0,
    updatedItems: 0,
    duplicateItems: 0,
    failedItems: 0,
    contentIds: [],
    failures: [],
  };

  for (let start = 0; start < documents.length; start += options.batchSize) {
    const batch = documents.slice(start, start + options.batchSize).map(documentToImportRow);
    const response = await options.client.submitSyncImport(buildRequest(batch, options));
    const data = response.data;
    summary.importedItems += data.completedItems ?? data.contentIds?.length ?? batch.length;
    summary.createdItems += data.createdItems ?? data.items?.filter((item) => item.outcome === 'created').length ?? 0;
    summary.updatedItems += data.updatedItems ?? data.items?.filter((item) => item.outcome === 'updated').length ?? 0;
    summary.duplicateItems += data.duplicateItems ?? data.items?.filter((item) => item.outcome === 'duplicate').length ?? 0;
    summary.failedItems += data.failedItems ?? data.failures?.length ?? 0;
    if (data.contentIds?.length) summary.contentIds.push(...data.contentIds);
    if (data.failures?.length) summary.failures.push(...data.failures);
  }

  return summary;
}
