import { describe, expect, it } from 'vitest';
import { conversationToImportRow } from '../sync/importer.js';
import { ConversationSchema } from '../sync/interchange.js';

describe('conversationToImportRow', () => {
  it('maps one normalized conversation to one chat content item', () => {
    const conversation = ConversationSchema.parse({
      provider: 'anthropic_claude',
      surface: 'claude_code',
      source_conversation_id: 'session-1',
      title: 'Architecture decision',
      created_at: '2026-08-10T20:00:00.000Z',
      archived: false,
      source_path: '/source/session-1.jsonl',
      source_sha256: 'b'.repeat(64),
      adapter_name: 'claude-code-history',
      adapter_version: '1.0.0',
      provider_metadata_json: { git_branch: 'main' },
      events: [
        {
          sequence: 0,
          source_event_id: 'event-1',
          category: 'message',
          role: 'user',
          provider_type: 'user',
          raw_json: { type: 'user' },
          content_blocks: [
            { ordinal: 0, block_type: 'text', text: 'Remember this decision.' },
          ],
        },
        {
          sequence: 1,
          source_event_id: 'event-2',
          category: 'reasoning',
          role: 'assistant',
          provider_type: 'response_item',
          provider_subtype: 'reasoning',
          raw_json: { type: 'response_item' },
          content_blocks: [
            {
              ordinal: 0,
              block_type: 'encrypted',
              json_payload: { encrypted_content: 'ciphertext-must-not-be-searchable' },
            },
          ],
        },
        {
          sequence: 2,
          source_event_id: 'event-3',
          category: 'lifecycle',
          role: null,
          provider_type: 'future_event',
          raw_json: { type: 'future_event' },
          content_blocks: [
            {
              ordinal: 0,
              block_type: 'opaque',
              json_payload: { private_future_payload: true },
            },
          ],
        },
      ],
      relations: [],
    });

    const row = conversationToImportRow(conversation);

    expect(row).toMatchObject({
      title: 'Architecture decision',
      content_type: 'chat',
      source_identifier: 'anthropic_claude:claude_code:session-1',
      source: 'claude-code',
      source_agent_id: 'claude',
      conversation_id: 'session-1',
      'metadata.sync.source_path': '/source/session-1.jsonl',
      'metadata.sync.source_sha256': 'b'.repeat(64),
      'metadata.sync.adapter_name': 'claude-code-history',
      'metadata.sync.adapter_version': '1.0.0',
    });
    expect(row.content).toContain('[user] Remember this decision.');
    expect(row.content).not.toContain('ciphertext-must-not-be-searchable');
    expect(row.content).not.toContain('private_future_payload');
    expect(row['source_data.chat_interchange']).toMatchObject({
      events: conversation.events,
      relations: [],
    });
  });
});
