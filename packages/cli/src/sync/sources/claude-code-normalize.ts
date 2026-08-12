import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import {
  ConversationSchema,
  type ContentBlock,
  type Conversation,
  type Event,
  type Relation,
  type ChatSurface,
} from '../interchange.js';

export const CLAUDE_CODE_ADAPTER_NAME = 'claude-code-history';
export const CLAUDE_CODE_ADAPTER_VERSION = '1.0.0';

export interface ClaudeCodeParsedRecord {
  line: number;
  value: Record<string, unknown>;
}

export interface ClaudeCodeStream {
  path: string;
  sha256: string;
  fallbackConversationId: string;
  fallbackTimestamp: string;
  records: readonly ClaudeCodeParsedRecord[];
  agentId?: string;
  metadata?: Record<string, unknown>;
}

export interface NormalizeClaudeCodeSessionInput {
  main: ClaudeCodeStream;
  subagents: readonly ClaudeCodeStream[];
}

export interface NormalizeClaudeCodeSessionOptions {
  surface?: ChatSurface;
  adapterName?: string;
  adapterVersion?: string;
  extraParentMetadata?: Record<string, unknown>;
  extraRelations?: readonly Relation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function jsonText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeTimestamp(value: unknown): { timestamp?: string; original?: string } {
  if (typeof value !== 'string' || !value.trim()) return {};
  if (Number.isNaN(Date.parse(value))) return { original: value };
  return { timestamp: new Date(value).toISOString(), original: value };
}

function deterministicEventId(path: string, line: number): string {
  return createHash('sha256').update(`${path}:${line}`).digest('hex');
}

function blockFromValue(value: unknown, ordinal: number): ContentBlock {
  if (typeof value === 'string') {
    return { ordinal, block_type: 'text', text: value };
  }
  if (!isRecord(value)) {
    return { ordinal, block_type: 'opaque', json_payload: value };
  }

  const type = getString(value, 'type');
  if (type === 'text') {
    return {
      ordinal,
      block_type: 'text',
      text: typeof value.text === 'string' ? value.text : '',
    };
  }
  if (type === 'thinking') {
    const signature = getString(value, 'signature');
    return {
      ordinal,
      block_type: 'thinking',
      text: typeof value.thinking === 'string' ? value.thinking : '',
      ...(signature ? { json_payload: { signature } } : {}),
    };
  }
  if (type === 'tool_use') {
    const toolCallId = getString(value, 'id');
    const toolName = getString(value, 'name');
    return {
      ordinal,
      block_type: 'tool_use',
      ...(toolCallId ? { tool_call_id: toolCallId } : {}),
      ...(toolName ? { tool_name: toolName } : {}),
      ...(value.input !== undefined ? { json_payload: value.input } : {}),
    };
  }
  if (type === 'tool_result') {
    const toolCallId = getString(value, 'tool_use_id');
    const content = value.content;
    return {
      ordinal,
      block_type: 'tool_result',
      ...(toolCallId ? { tool_call_id: toolCallId } : {}),
      ...(typeof content === 'string'
        ? { text: content }
        : content !== undefined
          ? { json_payload: content }
          : {}),
      ...(getBoolean(value, 'is_error') !== undefined
        ? { is_error: getBoolean(value, 'is_error') }
        : {}),
    };
  }

  return { ordinal, block_type: 'opaque', json_payload: value };
}

function messageContent(record: Record<string, unknown>): unknown {
  const message = isRecord(record.message) ? record.message : undefined;
  return message?.content ?? record.content ?? record.text ?? record.summary;
}

function contentBlocks(record: Record<string, unknown>): ContentBlock[] {
  const content = messageContent(record);
  if (Array.isArray(content)) return content.map(blockFromValue);
  if (content !== undefined && content !== null) return [blockFromValue(content, 0)];
  return [];
}

function isToolResultMessage(record: Record<string, unknown>): boolean {
  const message = isRecord(record.message) ? record.message : undefined;
  const content = message?.content;
  return Array.isArray(content) && content.length > 0 && content.every(
    (block) => isRecord(block) && getString(block, 'type') === 'tool_result',
  );
}

function titleText(record: Record<string, unknown>): string | undefined {
  return getString(record, 'title')
    ?? getString(record, 'customTitle')
    ?? getString(record, 'text')
    ?? jsonText(record.content);
}

function attachmentBlocks(record: Record<string, unknown>): ContentBlock[] {
  const path = getString(record, 'filePath')
    ?? getString(record, 'path')
    ?? getString(record, 'uri');
  const mimeType = getString(record, 'mimeType') ?? getString(record, 'mime_type');
  if (!path && !mimeType) return contentBlocks(record);
  return [{
    ordinal: 0,
    block_type: 'attachment',
    ...(path ? { uri_or_path: path } : {}),
    ...(mimeType ? { mime_type: mimeType } : {}),
  }];
}

function eventClassification(record: Record<string, unknown>): Pick<Event, 'category' | 'role' | 'provider_type' | 'provider_subtype'> {
  const providerType = getString(record, 'type') ?? 'unknown';
  const subtype = getString(record, 'subtype');

  if (providerType === 'assistant') {
    return { category: 'message', role: 'assistant', provider_type: providerType };
  }
  if (providerType === 'user') {
    return isToolResultMessage(record)
      ? { category: 'tool_result', role: 'tool', provider_type: providerType }
      : { category: 'message', role: 'user', provider_type: providerType };
  }
  if (providerType === 'ai-title' || providerType === 'custom-title') {
    return { category: 'title', role: null, provider_type: providerType };
  }
  if (providerType === 'system') {
    return {
      category: subtype === 'compact_boundary' ? 'compaction' : 'system',
      role: 'system',
      provider_type: providerType,
      ...(subtype ? { provider_subtype: subtype } : {}),
    };
  }
  if (providerType === 'attachment') {
    return { category: 'attachment', role: null, provider_type: providerType };
  }
  if (providerType === 'mode') {
    const mode = subtype ?? getString(record, 'mode');
    return {
      category: 'state',
      role: null,
      provider_type: providerType,
      ...(mode ? { provider_subtype: mode } : {}),
    };
  }
  if (['pr-link', 'frame-link', 'queue-operation', 'last-prompt'].includes(providerType)) {
    const lifecycleSubtype = subtype
      ?? getString(record, 'operation')
      ?? getString(record, 'action');
    return {
      category: 'lifecycle',
      role: null,
      provider_type: providerType,
      ...(lifecycleSubtype ? { provider_subtype: lifecycleSubtype } : {}),
    };
  }

  return {
    category: 'lifecycle',
    role: null,
    provider_type: providerType,
    ...(subtype ? { provider_subtype: subtype } : {}),
  };
}

function recordToEvent(parsed: ClaudeCodeParsedRecord, path: string, sequence: number): Event {
  const record = parsed.value;
  const type = getString(record, 'type') ?? 'unknown';
  const sourceEventId = getString(record, 'uuid')
    ?? deterministicEventId(path, parsed.line);
  const parentEventId = getString(record, 'parentUuid');
  const time = normalizeTimestamp(record.timestamp);
  const classification = eventClassification(record);
  const title = type === 'ai-title' || type === 'custom-title' ? titleText(record) : undefined;

  return {
    sequence,
    source_event_id: sourceEventId,
    ...(parentEventId ? { parent_event_id: parentEventId } : {}),
    ...(time.timestamp ? { timestamp: time.timestamp } : {}),
    ...(!time.timestamp && time.original ? { timestamp_original: time.original } : {}),
    ...classification,
    raw_json: record,
    content_blocks: type === 'attachment'
      ? attachmentBlocks(record)
      : title
        ? [{ ordinal: 0, block_type: 'text', text: title }]
        : contentBlocks(record),
  };
}

function latestValue(records: readonly ClaudeCodeParsedRecord[], key: string): unknown {
  let result: unknown;
  for (const { value } of records) {
    if (value[key] !== undefined) result = value[key];
    const message = isRecord(value.message) ? value.message : undefined;
    if (message?.[key] !== undefined) result = message[key];
  }
  return result;
}

function latestString(records: readonly ClaudeCodeParsedRecord[], key: string): string | undefined {
  const value = latestValue(records, key);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function conversationId(stream: ClaudeCodeStream): string {
  return latestString(stream.records, 'sessionId') ?? stream.fallbackConversationId;
}

function resolvedTitle(records: readonly ClaudeCodeParsedRecord[]): string | undefined {
  const customTitles = records
    .filter(({ value }) => getString(value, 'type') === 'custom-title')
    .map(({ value }) => titleText(value))
    .filter((title): title is string => Boolean(title));
  if (customTitles.length > 0) return customTitles.at(-1);

  const aiTitles = records
    .filter(({ value }) => getString(value, 'type') === 'ai-title')
    .map(({ value }) => titleText(value))
    .filter((title): title is string => Boolean(title));
  return aiTitles.at(-1);
}

function streamConversation(
  stream: ClaudeCodeStream,
  options: {
    sourceConversationId: string;
    parentSourceConversationId?: string;
    title?: string;
    surface: ChatSurface;
    adapterName: string;
    adapterVersion: string;
    extraMetadata?: Record<string, unknown>;
  },
): Conversation {
  const events = stream.records.map((record, index) => recordToEvent(record, stream.path, index));
  const timestamps = events.flatMap((event) => event.timestamp ? [event.timestamp] : []);
  const cwd = latestString(stream.records, 'cwd');
  const model = latestString(stream.records, 'model');
  const reasoningEffort = latestString(stream.records, 'effort');
  const requestId = latestString(stream.records, 'requestId')
    ?? latestString(stream.records, 'request_id');
  const providerMetadata: Record<string, unknown> = {
    ...(stream.metadata ?? {}),
    ...(options.extraMetadata ?? {}),
    ...(stream.agentId ? { agentId: stream.agentId } : {}),
    sessionId: conversationId(stream),
  };
  const gitBranch = latestString(stream.records, 'gitBranch');
  const version = latestString(stream.records, 'version');
  const usage = latestValue(stream.records, 'usage');
  if (gitBranch) providerMetadata.gitBranch = gitBranch;
  if (version) providerMetadata.version = version;
  if (requestId) providerMetadata.requestId = requestId;
  if (usage !== undefined) providerMetadata.usage = usage;

  const relations: Relation[] = events.flatMap((event, index) => {
    const record = stream.records[index]?.value;
    if (!record || record.isSidechain !== true) return [];
    return [{
      relation_type: 'sidechain' as const,
      source_event_id: event.source_event_id,
      ...(event.parent_event_id
        ? { target_source_event_id: event.parent_event_id }
        : { target_source_conversation_id: options.sourceConversationId }),
    }];
  });

  return ConversationSchema.parse({
    provider: 'anthropic_claude',
    surface: options.surface,
    source_conversation_id: options.sourceConversationId,
    ...(options.parentSourceConversationId
      ? { parent_source_conversation_id: options.parentSourceConversationId }
      : {}),
    ...(options.title ? { title: options.title } : {}),
    ...(cwd ? { cwd } : {}),
    created_at: timestamps[0] ?? stream.fallbackTimestamp,
    ...(timestamps.length > 1 ? { updated_at: timestamps.at(-1) } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    archived: false,
    source_path: stream.path,
    source_sha256: stream.sha256,
    adapter_name: options.adapterName,
    adapter_version: options.adapterVersion,
    provider_metadata_json: providerMetadata,
    events,
    relations,
  });
}

function eventForToolUse(conversation: Conversation, toolUseId: string): Event | undefined {
  return conversation.events.find((event) => event.content_blocks.some(
    (block) => block.block_type === 'tool_use' && block.tool_call_id === toolUseId,
  ));
}

function agentIdFromPath(path: string): string {
  return basename(path).replace(/^agent-/, '').replace(/\.jsonl$/i, '');
}

export function normalizeClaudeCodeSession(
  input: NormalizeClaudeCodeSessionInput,
  options: NormalizeClaudeCodeSessionOptions = {},
): Conversation[] {
  const surface = options.surface ?? 'claude_code';
  const adapterName = options.adapterName ?? CLAUDE_CODE_ADAPTER_NAME;
  const adapterVersion = options.adapterVersion ?? CLAUDE_CODE_ADAPTER_VERSION;
  const parentId = conversationId(input.main);
  const parent = streamConversation(input.main, {
    sourceConversationId: parentId,
    title: resolvedTitle(input.main.records),
    surface,
    adapterName,
    adapterVersion,
    ...(options.extraParentMetadata
      ? { extraMetadata: options.extraParentMetadata }
      : {}),
  });
  const children = input.subagents.map((stream) => {
    const agentId = stream.agentId ?? agentIdFromPath(stream.path);
    return streamConversation(stream, {
      sourceConversationId: `${parentId}:agent:${agentId}`,
      parentSourceConversationId: parentId,
      title: typeof stream.metadata?.description === 'string'
        ? stream.metadata.description
        : `Claude subagent ${agentId}`,
      surface,
      adapterName,
      adapterVersion,
    });
  });

  const spawnRelations: Relation[] = children.map((child, index) => {
    const toolUseId = input.subagents[index]?.metadata?.toolUseId;
    const sourceEvent = typeof toolUseId === 'string'
      ? eventForToolUse(parent, toolUseId)
      : undefined;
    return {
      relation_type: 'spawn',
      ...(sourceEvent ? { source_event_id: sourceEvent.source_event_id } : {}),
      target_source_conversation_id: child.source_conversation_id,
    };
  });

  const validatedParent = ConversationSchema.parse({
    ...parent,
    relations: [
      ...parent.relations,
      ...spawnRelations,
      ...(options.extraRelations ?? []),
    ],
  });
  return [validatedParent, ...children.map((child) => ConversationSchema.parse(child))];
}
