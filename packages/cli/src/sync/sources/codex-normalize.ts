import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import {
  ConversationSchema,
  type ContentBlock,
  type Conversation,
  type Event,
  type Relation,
} from '../interchange.js';
import type { CodexThreadMetadata } from './codex-state-db.js';

export const CODEX_ADAPTER_NAME = 'codex-history';
export const CODEX_ADAPTER_VERSION = '1.0.0';

export interface CodexParsedRecord {
  line: number;
  value: Record<string, unknown>;
}

export interface NormalizeCodexSessionInput {
  records: readonly CodexParsedRecord[];
  path: string;
  sha256: string;
  fallbackTimestamp: string;
  threadMeta?: CodexThreadMetadata;
  archived: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function normalizeTimestamp(value: unknown): { timestamp?: string; original?: string } {
  if (typeof value !== 'string' || !value.trim()) return {};
  if (Number.isNaN(Date.parse(value))) return { original: value };
  return { timestamp: new Date(value).toISOString(), original: value };
}

function normalizeDatabaseTimestamp(value: string | number | undefined): string | undefined {
  if (typeof value === 'string') return normalizeTimestamp(value).timestamp;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const milliseconds = value < 100_000_000_000 ? value * 1_000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function deterministicEventId(path: string, line: number): string {
  return createHash('sha256').update(`${path}:${line}`).digest('hex');
}

function sourceEventIds(records: readonly CodexParsedRecord[], path: string): string[] {
  const used = new Set<string>();
  return records.map((record) => {
    const payload = isRecord(record.value.payload) ? record.value.payload : undefined;
    const preferred = payload ? getString(payload, 'id') : undefined;
    const candidate = preferred && !used.has(preferred)
      ? preferred
      : deterministicEventId(path, record.line);
    used.add(candidate);
    return candidate;
  });
}

function messageRole(value: unknown): Event['role'] {
  if (value === 'user' || value === 'assistant' || value === 'system'
    || value === 'developer' || value === 'tool') {
    return value;
  }
  return null;
}

function responseMessageBlocks(payload: Record<string, unknown>): ContentBlock[] {
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content.map((value, ordinal): ContentBlock => {
    if (!isRecord(value)) return { ordinal, block_type: 'opaque', json_payload: value };
    const type = getString(value, 'type');
    if (type === 'input_text' || type === 'output_text') {
      return {
        ordinal,
        block_type: type,
        text: typeof value.text === 'string' ? value.text : '',
      };
    }
    return { ordinal, block_type: 'opaque', json_payload: value };
  });
}

function toolCallBlock(payload: Record<string, unknown>, ordinal = 0): ContentBlock {
  const callId = getString(payload, 'call_id') ?? getString(payload, 'id');
  const toolName = getString(payload, 'name') ?? 'tool';
  const input = payload.arguments !== undefined ? payload.arguments : payload.input;
  return {
    ordinal,
    block_type: 'tool_use',
    ...(callId ? { tool_call_id: callId } : {}),
    tool_name: toolName,
    ...(input !== undefined ? { json_payload: input } : {}),
  };
}

function toolResultBlock(payload: Record<string, unknown>): ContentBlock {
  const callId = getString(payload, 'call_id') ?? getString(payload, 'id');
  const output = payload.output;
  return {
    ordinal: 0,
    block_type: 'tool_result',
    ...(callId ? { tool_call_id: callId } : {}),
    ...(typeof output === 'string'
      ? { text: output }
      : output !== undefined
        ? { json_payload: output }
        : {}),
    ...(typeof payload.is_error === 'boolean' ? { is_error: payload.is_error } : {}),
  };
}

function reasoningBlock(payload: Record<string, unknown>): ContentBlock {
  const opaque: Record<string, unknown> = {};
  for (const key of ['encrypted_content', 'summary', 'content']) {
    if (hasOwn(payload, key)) opaque[key] = payload[key];
  }
  return { ordinal: 0, block_type: 'encrypted', json_payload: opaque };
}

function webSearchBlock(payload: Record<string, unknown>): ContentBlock {
  const callId = getString(payload, 'call_id') ?? getString(payload, 'id');
  const details: Record<string, unknown> = {};
  for (const key of ['action', 'status', 'internal_chat_message_metadata_passthrough']) {
    if (hasOwn(payload, key)) details[key] = payload[key];
  }
  return {
    ordinal: 0,
    block_type: 'tool_use',
    ...(callId ? { tool_call_id: callId } : {}),
    tool_name: 'web_search',
    ...(Object.keys(details).length > 0 ? { json_payload: details } : {}),
  };
}

function opaqueBlock(payload: unknown): ContentBlock {
  return { ordinal: 0, block_type: 'opaque', json_payload: payload };
}

function eventMsgCategory(subtype: string | undefined): Event['category'] {
  if (subtype === 'token_count') return 'usage';
  if (subtype === 'thread_goal_updated' || subtype === 'thread_settings_applied'
    || subtype === 'thread_name_updated') {
    return 'state';
  }
  return 'lifecycle';
}

const KNOWN_EVENT_MSG_TYPES = new Set([
  'user_message',
  'agent_message',
  'agent_reasoning',
  'task_started',
  'task_complete',
  'token_count',
  'exec_command_end',
  'patch_apply_end',
  'mcp_tool_call_end',
  'web_search_end',
  'sub_agent_activity',
  'thread_goal_updated',
  'thread_settings_applied',
  'thread_name_updated',
  'turn_aborted',
]);

function recordToEvent(
  parsed: CodexParsedRecord,
  sourceEventId: string,
  sequence: number,
): Event {
  const record = parsed.value;
  const providerType = getString(record, 'type') ?? 'unknown';
  const rawPayload = record.payload;
  const payload = isRecord(rawPayload) ? rawPayload : {};
  const providerSubtype = getString(payload, 'type');
  const time = normalizeTimestamp(record.timestamp);
  const common = {
    sequence,
    source_event_id: sourceEventId,
    ...(time.timestamp ? { timestamp: time.timestamp } : {}),
    ...(!time.timestamp && time.original ? { timestamp_original: time.original } : {}),
    provider_type: providerType,
    ...(providerSubtype ? { provider_subtype: providerSubtype } : {}),
    raw_json: record,
  };

  if (providerType === 'response_item') {
    if (providerSubtype === 'message') {
      return {
        ...common,
        category: 'message',
        role: messageRole(payload.role),
        content_blocks: responseMessageBlocks(payload),
      };
    }
    if (providerSubtype === 'function_call' || providerSubtype === 'custom_tool_call') {
      return {
        ...common,
        category: 'tool_call',
        role: 'assistant',
        content_blocks: [toolCallBlock(payload)],
      };
    }
    if (providerSubtype === 'function_call_output'
      || providerSubtype === 'custom_tool_call_output') {
      return {
        ...common,
        category: 'tool_result',
        role: 'tool',
        content_blocks: [toolResultBlock(payload)],
      };
    }
    if (providerSubtype === 'reasoning') {
      return {
        ...common,
        category: 'reasoning',
        role: 'assistant',
        content_blocks: [reasoningBlock(payload)],
      };
    }
    if (providerSubtype === 'web_search_call') {
      return {
        ...common,
        category: 'tool_call',
        role: 'assistant',
        content_blocks: [webSearchBlock(payload)],
      };
    }
    return {
      ...common,
      category: 'lifecycle',
      role: null,
      content_blocks: [opaqueBlock(rawPayload)],
    };
  }

  if (providerType === 'event_msg') {
    return {
      ...common,
      category: eventMsgCategory(providerSubtype),
      role: null,
      content_blocks: providerSubtype && KNOWN_EVENT_MSG_TYPES.has(providerSubtype)
        ? []
        : [opaqueBlock(rawPayload)],
    };
  }

  if (providerType === 'session_meta' || providerType === 'turn_context'
    || providerType === 'world_state') {
    return { ...common, category: 'state', role: null, content_blocks: [] };
  }
  if (providerType === 'compacted') {
    return { ...common, category: 'compaction', role: null, content_blocks: [] };
  }
  if (providerType === 'inter_agent_communication_metadata') {
    return { ...common, category: 'lifecycle', role: null, content_blocks: [] };
  }
  return {
    ...common,
    category: 'lifecycle',
    role: null,
    content_blocks: [opaqueBlock(rawPayload)],
  };
}

function normalizedPresentationText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

function canonicalMessageKey(event: Event): string | undefined {
  if (event.category !== 'message' || (event.role !== 'user' && event.role !== 'assistant')) {
    return undefined;
  }
  const text = normalizedPresentationText(
    event.content_blocks.map((block) => block.text ?? '').filter(Boolean).join('\n'),
  );
  return text ? `${event.role}\0${text}` : undefined;
}

function duplicatePresentationRelations(events: readonly Event[]): Relation[] {
  const canonicalByContent = new Map<string, string[]>();
  for (const event of events) {
    const key = canonicalMessageKey(event);
    if (!key) continue;
    const ids = canonicalByContent.get(key) ?? [];
    ids.push(event.source_event_id);
    canonicalByContent.set(key, ids);
  }

  const matched = new Map<string, number>();
  const relations: Relation[] = [];
  for (const event of events) {
    if (event.provider_type !== 'event_msg') continue;
    const payload = isRecord(event.raw_json.payload) ? event.raw_json.payload : {};
    const subtype = getString(payload, 'type');
    const role = subtype === 'user_message'
      ? 'user'
      : subtype === 'agent_message'
        ? 'assistant'
        : undefined;
    const text = normalizedPresentationText(
      payload.message ?? payload.text ?? payload.content,
    );
    if (!role || !text) continue;
    const key = `${role}\0${text}`;
    const targets = canonicalByContent.get(key);
    if (!targets?.length) continue;
    const index = matched.get(key) ?? 0;
    const target = targets[Math.min(index, targets.length - 1)];
    matched.set(key, index + 1);
    relations.push({
      relation_type: 'duplicate_of',
      source_event_id: event.source_event_id,
      target_source_event_id: target,
      rule_id: 'codex-eventmsg-dup',
      rule_version: CODEX_ADAPTER_VERSION,
    });
  }
  return relations;
}

function sessionMeta(records: readonly CodexParsedRecord[]): Record<string, unknown> | undefined {
  for (const record of records) {
    if (getString(record.value, 'type') !== 'session_meta') continue;
    if (isRecord(record.value.payload)) return record.value.payload;
  }
  return undefined;
}

function fallbackConversationId(path: string): string {
  return basename(path).replace(/^rollout-/, '').replace(/\.jsonl$/i, '');
}

export function codexSessionId(records: readonly CodexParsedRecord[]): string | undefined {
  const meta = sessionMeta(records);
  return meta ? getString(meta, 'id') ?? getString(meta, 'session_id') : undefined;
}

export function normalizeCodexSession(input: NormalizeCodexSessionInput): Conversation[] {
  const meta = sessionMeta(input.records) ?? {};
  const metaId = getString(meta, 'id');
  const metaSessionId = getString(meta, 'session_id');
  const sourceConversationId = metaId
    ?? metaSessionId
    ?? input.threadMeta?.id
    ?? fallbackConversationId(input.path);
  const ids = sourceEventIds(input.records, input.path);
  const events = input.records.map((record, index) => recordToEvent(
    record,
    ids[index],
    record.line - 1,
  ));
  const eventTimestamps = events.flatMap((event) => event.timestamp ? [event.timestamp] : []);
  const sessionTime = normalizeTimestamp(meta.timestamp);
  const recordSessionTime = input.records.find(
    (record) => getString(record.value, 'type') === 'session_meta',
  );
  const envelopeSessionTime = normalizeTimestamp(recordSessionTime?.value.timestamp);
  const dbCreatedAt = normalizeDatabaseTimestamp(input.threadMeta?.created_at);
  const dbUpdatedAt = normalizeDatabaseTimestamp(input.threadMeta?.updated_at);
  const createdAt = sessionTime.timestamp
    ?? envelopeSessionTime.timestamp
    ?? dbCreatedAt
    ?? eventTimestamps[0]
    ?? input.fallbackTimestamp;
  const updatedAt = dbUpdatedAt ?? eventTimestamps.at(-1);
  const cwd = input.threadMeta?.cwd ?? getString(meta, 'cwd');
  const title = input.threadMeta?.title ?? input.threadMeta?.name;
  const model = input.threadMeta?.model;
  const reasoningEffort = input.threadMeta?.reasoning_effort;

  const providerMetadata: Record<string, unknown> = {};
  for (const key of [
    'cwd',
    'model_provider',
    'cli_version',
    'source',
    'thread_source',
    'originator',
    'base_instructions',
    'dynamic_tools',
    'history_mode',
    'context_window',
  ]) {
    if (hasOwn(meta, key)) providerMetadata[key] = meta[key];
  }
  if (metaId) providerMetadata.session_meta_id = metaId;
  if (metaSessionId) providerMetadata.session_meta_session_id = metaSessionId;
  if (getString(meta, 'cwd')) providerMetadata.session_cwd = getString(meta, 'cwd');
  if (metaId && metaSessionId && metaId !== metaSessionId) {
    providerMetadata.session_meta_id_mismatch = { id: metaId, session_id: metaSessionId };
  }
  if (isRecord(meta.git)) providerMetadata.session_git = meta.git;

  const threadMeta = input.threadMeta;
  if (threadMeta) {
    for (const key of [
      'rollout_path',
      'name',
      'git_branch',
      'git_origin_url',
      'git_sha',
      'tokens_used',
      'has_user_event',
      'created_at',
      'updated_at',
    ] as const) {
      if (threadMeta[key] !== undefined) providerMetadata[key] = threadMeta[key];
    }
    providerMetadata.thread_id = threadMeta.id;
    providerMetadata.thread_archived = threadMeta.archived;
    if (threadMeta.title) providerMetadata.title = threadMeta.title;
    if (threadMeta.model) providerMetadata.model = threadMeta.model;
    if (threadMeta.reasoning_effort) {
      providerMetadata.reasoning_effort = threadMeta.reasoning_effort;
    }
    if (threadMeta.cwd) providerMetadata.cwd = threadMeta.cwd;
    if (threadMeta.archived !== undefined) providerMetadata.archived = threadMeta.archived;
    if (threadMeta.id !== sourceConversationId) {
      providerMetadata.thread_id_mismatch = {
        session_id: sourceConversationId,
        thread_id: threadMeta.id,
      };
    }
    if (threadMeta.archived !== undefined && threadMeta.archived !== input.archived) {
      providerMetadata.archive_state_mismatch = {
        directory_archived: input.archived,
        database_archived: threadMeta.archived,
      };
    }
  }

  const conversation = ConversationSchema.parse({
    provider: 'openai_codex',
    surface: 'codex',
    source_conversation_id: sourceConversationId,
    ...(title ? { title } : {}),
    ...(cwd ? { cwd } : {}),
    created_at: createdAt,
    ...(!sessionTime.timestamp && sessionTime.original
      ? { created_at_original: sessionTime.original }
      : {}),
    ...(updatedAt && updatedAt !== createdAt ? { updated_at: updatedAt } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    archived: input.archived,
    source_path: input.path,
    source_sha256: input.sha256,
    adapter_name: CODEX_ADAPTER_NAME,
    adapter_version: CODEX_ADAPTER_VERSION,
    provider_metadata_json: providerMetadata,
    events,
    relations: duplicatePresentationRelations(events),
  });
  return [conversation];
}
