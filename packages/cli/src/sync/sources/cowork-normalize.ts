import { createHash } from 'node:crypto';
import {
  ConversationSchema,
  type Conversation,
  type Event,
  type Relation,
} from '../interchange.js';
import {
  normalizeClaudeCodeSession,
  type ClaudeCodeParsedRecord,
  type NormalizeClaudeCodeSessionInput,
} from './claude-code-normalize.js';

export const COWORK_ADAPTER_NAME = 'cowork-history';
export const COWORK_ADAPTER_VERSION = '1.0.1';

const AUDIT_DUPLICATE_RULE_ID = 'cowork-nested-transcript-over-audit-message';
const AUDIT_DUPLICATE_RULE_VERSION = '1';

export interface CoworkSidecarReference {
  source_path: string;
  archive_path: string;
  archive_manifest_path: string;
  sha256: string;
}

export interface CoworkArtifactReference {
  source_path: string;
  archive_path: string;
  sha256: string;
  size: number;
}

export interface NormalizeCoworkSessionInput extends NormalizeClaudeCodeSessionInput {
  outerMetadata: Record<string, unknown>;
  auditRecords: readonly ClaudeCodeParsedRecord[];
  auditSidecar: CoworkSidecarReference;
  artifacts: readonly CoworkArtifactReference[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function auditRecordType(record: Record<string, unknown>): string | undefined {
  return getString(record, 'type')
    ?? (isRecord(record.event) ? getString(record.event, 'type') : undefined);
}

function auditMessageTargetIds(record: Record<string, unknown>): string[] {
  const event = isRecord(record.event) ? record.event : record;
  const message = isRecord(event.message) ? event.message : undefined;
  return [...new Set([
    getString(message ?? {}, 'id'),
    getString(event, 'messageId'),
    getString(event, 'message_id'),
    getString(event, 'uuid'),
  ].filter((value): value is string => Boolean(value)))];
}

function auditSourceEventId(
  record: Record<string, unknown>,
  auditPath: string,
  line: number,
): string {
  const event = isRecord(record.event) ? record.event : record;
  const id = getString(event, 'uuid')
    ?? getString(event, 'id')
    ?? createHash('sha256').update(`${auditPath}:${line}`).digest('hex');
  // Cowork audit sidecars can repeat a UUID on multiple physical records.
  // The source line is part of the archived identity and keeps every event
  // deterministic without discarding any repeated audit evidence.
  return `cowork-audit:${id}:line:${line}`;
}

function auditTimestamp(record: Record<string, unknown>): string | undefined {
  const value = getString(record, '_audit_timestamp')
    ?? (isRecord(record.event) ? getString(record.event, '_audit_timestamp') : undefined);
  if (!value || Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function auditMessageStub(
  parsed: ClaudeCodeParsedRecord,
  auditPath: string,
  sequence: number,
  type: string,
): Event {
  const timestamp = auditTimestamp(parsed.value);
  return {
    sequence,
    source_event_id: auditSourceEventId(parsed.value, auditPath, parsed.line),
    ...(timestamp ? { timestamp } : {}),
    category: 'lifecycle',
    role: null,
    provider_type: 'audit',
    provider_subtype: type,
    raw_json: parsed.value,
    content_blocks: [],
  };
}

function signedAudit(records: readonly ClaudeCodeParsedRecord[]): boolean {
  return records.length > 0 && records.every(({ value }) =>
    Boolean(getString(value, '_audit_hmac') && getString(value, '_audit_timestamp'))
  );
}

export function normalizeCoworkSession(input: NormalizeCoworkSessionInput): Conversation[] {
  const conversations = normalizeClaudeCodeSession(
    { main: input.main, subagents: input.subagents },
    {
      surface: 'claude_cowork',
      adapterName: COWORK_ADAPTER_NAME,
      adapterVersion: COWORK_ADAPTER_VERSION,
      extraParentMetadata: {
        cowork_session: input.outerMetadata,
        sensitive_metadata: ['cowork_session'],
        audit_sidecar: {
          ...input.auditSidecar,
          signed: signedAudit(input.auditRecords),
          hmac_verified: false,
          record_count: input.auditRecords.length,
        },
        audit_exclusive: {
          rate_limit_event_count: input.auditRecords.filter(
            ({ value }) => auditRecordType(value) === 'rate_limit_event',
          ).length,
          result_count: input.auditRecords.filter(
            ({ value }) => auditRecordType(value) === 'result',
          ).length,
        },
        cowork_artifacts: input.artifacts,
      },
    },
  );

  const additions = new Map<number, { events: Event[]; relations: Relation[] }>();
  let duplicateMessageRecords = 0;
  for (const parsed of input.auditRecords) {
    const type = auditRecordType(parsed.value);
    if (type !== 'user' && type !== 'assistant') continue;

    let match: { conversationIndex: number; targetEventId: string } | undefined;
    for (const targetId of auditMessageTargetIds(parsed.value)) {
      const conversationIndex = conversations.findIndex((conversation) =>
        conversation.events.some((event) => event.source_event_id === targetId)
      );
      if (conversationIndex >= 0) {
        match = { conversationIndex, targetEventId: targetId };
        break;
      }
    }
    if (!match) continue;

    const conversation = conversations[match.conversationIndex];
    const existing = additions.get(match.conversationIndex) ?? { events: [], relations: [] };
    const event = auditMessageStub(
      parsed,
      input.auditSidecar.source_path,
      conversation.events.length + existing.events.length,
      type,
    );
    existing.events.push(event);
    existing.relations.push({
      relation_type: 'duplicate_of',
      source_event_id: event.source_event_id,
      target_source_event_id: match.targetEventId,
      rule_id: AUDIT_DUPLICATE_RULE_ID,
      rule_version: AUDIT_DUPLICATE_RULE_VERSION,
    });
    additions.set(match.conversationIndex, existing);
    duplicateMessageRecords += 1;
  }

  return conversations.map((conversation, index) => {
    const extra = additions.get(index) ?? { events: [], relations: [] };
    const providerMetadata = index === 0
      ? {
          ...conversation.provider_metadata_json,
          audit_sidecar: {
            ...(conversation.provider_metadata_json.audit_sidecar as Record<string, unknown>),
            duplicate_message_records: duplicateMessageRecords,
          },
        }
      : conversation.provider_metadata_json;
    return ConversationSchema.parse({
      ...conversation,
      provider_metadata_json: providerMetadata,
      events: [...conversation.events, ...extra.events],
      relations: [...conversation.relations, ...extra.relations],
    });
  });
}
