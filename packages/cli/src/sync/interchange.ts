import { z } from 'zod';

export const CHAT_INTERCHANGE_VERSION = 1 as const;
export const ADAPTER_INTERCHANGE_VERSION = CHAT_INTERCHANGE_VERSION;

const NonEmptyStringSchema = z.string().trim().min(1);
const UtcTimestampSchema = z.string().datetime();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, 'must be a SHA-256 hex digest');

export const ChatProviderSchema = z.enum(['openai_codex', 'anthropic_claude']);
export const ChatSurfaceSchema = z.enum([
  'codex',
  'claude_code',
  'claude_cowork',
  'claude_cloud_export',
]);
export const EventCategorySchema = z.enum([
  'message',
  'reasoning',
  'tool_call',
  'tool_result',
  'system',
  'lifecycle',
  'usage',
  'attachment',
  'title',
  'compaction',
  'state',
]);
export const EventRoleSchema = z.enum([
  'user',
  'assistant',
  'system',
  'developer',
  'tool',
]);
export const ContentBlockTypeSchema = z.enum([
  'text',
  'thinking',
  'input_text',
  'output_text',
  'tool_use',
  'tool_result',
  'attachment',
  'encrypted',
  'opaque',
]);

export const ContentBlockSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  block_type: ContentBlockTypeSchema,
  text: z.string().optional(),
  mime_type: NonEmptyStringSchema.optional(),
  uri_or_path: NonEmptyStringSchema.optional(),
  tool_call_id: NonEmptyStringSchema.optional(),
  tool_name: NonEmptyStringSchema.optional(),
  json_payload: z.unknown().optional(),
  is_error: z.boolean().optional(),
}).strict();

export const EventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  source_event_id: NonEmptyStringSchema,
  parent_event_id: NonEmptyStringSchema.optional(),
  timestamp: UtcTimestampSchema.optional(),
  timestamp_original: NonEmptyStringSchema.optional(),
  category: EventCategorySchema,
  role: EventRoleSchema.nullable(),
  provider_type: NonEmptyStringSchema,
  provider_subtype: NonEmptyStringSchema.optional(),
  raw_json: z.record(z.unknown()),
  content_blocks: z.array(ContentBlockSchema),
}).strict().superRefine((event, context) => {
  const ordinals = new Set<number>();
  for (const [index, block] of event.content_blocks.entries()) {
    if (ordinals.has(block.ordinal)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content_blocks', index, 'ordinal'],
        message: `duplicate content block ordinal ${block.ordinal}`,
      });
    }
    ordinals.add(block.ordinal);
  }
});

export const RelationTypeSchema = z.enum([
  'fork',
  'spawn',
  'sidechain',
  'bridge',
  'duplicate_of',
]);

export const RelationSchema = z.object({
  relation_type: RelationTypeSchema,
  source_event_id: NonEmptyStringSchema.optional(),
  target_source_conversation_id: NonEmptyStringSchema.optional(),
  target_source_event_id: NonEmptyStringSchema.optional(),
  rule_id: NonEmptyStringSchema.optional(),
  rule_version: NonEmptyStringSchema.optional(),
}).strict().superRefine((relation, context) => {
  if (!relation.target_source_conversation_id && !relation.target_source_event_id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target_source_conversation_id'],
      message: 'a relation must identify a target conversation or event',
    });
  }
  if (relation.relation_type === 'duplicate_of') {
    if (!relation.rule_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rule_id'],
        message: 'duplicate_of relations require rule_id',
      });
    }
    if (!relation.rule_version) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rule_version'],
        message: 'duplicate_of relations require rule_version',
      });
    }
  }
});

const CONVERSATION_FIELDS = new Set([
  'provider',
  'surface',
  'source_conversation_id',
  'parent_source_conversation_id',
  'title',
  'cwd',
  'created_at',
  'created_at_original',
  'updated_at',
  'updated_at_original',
  'model',
  'reasoning_effort',
  'archived',
  'source_path',
  'source_sha256',
  'adapter_name',
  'adapter_version',
  'provider_metadata_json',
  'events',
  'relations',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function preserveConversationProviderFields(value: unknown): unknown {
  if (!isRecord(value)) return value;

  const normalized: Record<string, unknown> = { ...value };
  const existingMetadata = value.provider_metadata_json;
  const metadata = isRecord(existingMetadata) ? { ...existingMetadata } : existingMetadata;
  const unknownFields: Record<string, unknown> = {};

  for (const [key, fieldValue] of Object.entries(value)) {
    if (CONVERSATION_FIELDS.has(key)) continue;
    unknownFields[key] = fieldValue;
    delete normalized[key];
  }

  if (Object.keys(unknownFields).length > 0) {
    normalized.provider_metadata_json = isRecord(metadata)
      ? { ...metadata, ...unknownFields }
      : metadata;
  }

  return normalized;
}

const ConversationObjectSchema = z.object({
  provider: ChatProviderSchema,
  surface: ChatSurfaceSchema,
  source_conversation_id: NonEmptyStringSchema,
  parent_source_conversation_id: NonEmptyStringSchema.optional(),
  title: NonEmptyStringSchema.optional(),
  cwd: NonEmptyStringSchema.optional(),
  created_at: UtcTimestampSchema,
  created_at_original: NonEmptyStringSchema.optional(),
  updated_at: UtcTimestampSchema.optional(),
  updated_at_original: NonEmptyStringSchema.optional(),
  model: NonEmptyStringSchema.optional(),
  reasoning_effort: NonEmptyStringSchema.optional(),
  archived: z.boolean(),
  source_path: NonEmptyStringSchema,
  source_sha256: Sha256Schema,
  adapter_name: NonEmptyStringSchema,
  adapter_version: NonEmptyStringSchema,
  provider_metadata_json: z.record(z.unknown()),
  events: z.array(EventSchema),
  relations: z.array(RelationSchema),
}).strict().superRefine((conversation, context) => {
  const sequences = new Set<number>();
  const eventIds = new Set<string>();
  for (const [index, event] of conversation.events.entries()) {
    if (sequences.has(event.sequence)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['events', index, 'sequence'],
        message: `duplicate event sequence ${event.sequence}`,
      });
    }
    if (eventIds.has(event.source_event_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['events', index, 'source_event_id'],
        message: `duplicate source_event_id ${event.source_event_id}`,
      });
    }
    sequences.add(event.sequence);
    eventIds.add(event.source_event_id);
  }
});

export const ConversationSchema = z.preprocess(
  preserveConversationProviderFields,
  ConversationObjectSchema,
);

export const ChatHistoryInterchangeSchema = z.object({
  interchange_version: z.literal(CHAT_INTERCHANGE_VERSION),
  conversations: z.array(ConversationSchema).min(1),
}).strict();

export type ChatProvider = z.infer<typeof ChatProviderSchema>;
export type ChatSurface = z.infer<typeof ChatSurfaceSchema>;
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type Event = z.infer<typeof EventSchema>;
export type Relation = z.infer<typeof RelationSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type ChatHistoryInterchange = z.infer<typeof ChatHistoryInterchangeSchema>;
