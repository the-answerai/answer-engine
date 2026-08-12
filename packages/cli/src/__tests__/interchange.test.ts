import { describe, expect, it } from 'vitest';
import {
  CHAT_INTERCHANGE_VERSION,
  ChatHistoryInterchangeSchema,
  ConversationSchema,
  RelationSchema,
} from '../sync/interchange.js';

function conversationFixture(): Record<string, unknown> {
  return {
    provider: 'anthropic_claude',
    surface: 'claude_code',
    source_conversation_id: 'session-1',
    title: 'Planning session',
    created_at: '2026-08-10T20:00:00.000Z',
    created_at_original: '2026-08-10T13:00:00-07:00',
    archived: false,
    source_path: '/source/session-1.jsonl',
    source_sha256: 'a'.repeat(64),
    adapter_name: 'claude-code-history',
    adapter_version: '1.0.0',
    provider_metadata_json: { retained: true },
    vendor_workspace: { branch: 'main' },
    events: [
      {
        sequence: 0,
        source_event_id: 'event-1',
        timestamp: '2026-08-10T20:00:00.000Z',
        category: 'message',
        role: 'user',
        provider_type: 'user',
        raw_json: { type: 'user', uuid: 'event-1' },
        content_blocks: [
          { ordinal: 0, block_type: 'text', text: 'Remember this decision.' },
        ],
      },
    ],
    relations: [],
  };
}

describe('chat-history interchange schemas', () => {
  it('preserves unknown provider fields in provider_metadata_json', () => {
    const parsed = ConversationSchema.parse(conversationFixture());

    expect(parsed.provider_metadata_json).toEqual({
      retained: true,
      vendor_workspace: { branch: 'main' },
    });
    expect('vendor_workspace' in parsed).toBe(false);
  });

  it.each(['adapter_name', 'adapter_version'])(
    'requires %s on every conversation',
    (field) => {
      const conversation = conversationFixture();
      delete conversation[field];

      expect(ConversationSchema.safeParse(conversation).success).toBe(false);
    },
  );

  it('requires duplicate relations to name the dedup rule and version', () => {
    const result = RelationSchema.safeParse({
      relation_type: 'duplicate_of',
      target_source_event_id: 'canonical-event',
    });

    expect(result.success).toBe(false);
  });

  it('validates a versioned request envelope', () => {
    const parsed = ChatHistoryInterchangeSchema.parse({
      interchange_version: CHAT_INTERCHANGE_VERSION,
      conversations: [conversationFixture()],
    });

    expect(parsed.conversations).toHaveLength(1);
  });
});
