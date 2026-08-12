import { describe, expect, it } from 'vitest';
import { conversationToImportRow } from '../sync/importer.js';
import { ConversationSchema } from '../sync/interchange.js';

describe('conversationToImportRow', () => {
  it('maps one normalized conversation to one chat content item', () => {
    const conversation = ConversationSchema.parse({
      provider: 'anthropic_claude',
      surface: 'claude_code',
      source_conversation_id: 'session-1',
      title: `Architecture decision ${'details '.repeat(100)}`,
      created_at: '2026-08-10T20:00:00.000Z',
      archived: false,
      source_path: '/source/session-1.jsonl',
      source_sha256: 'b'.repeat(64),
      adapter_name: 'claude-code-history',
      adapter_version: '1.0.0',
      provider_metadata_json: {
        git_branch: 'main',
        raw_archive_manifest: {
          manifest_path: '/archive/session-1/manifest.json',
          version: 1,
          files: [{ path: '/source/session-1.jsonl', sha256: 'b'.repeat(64) }],
        },
      },
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
    expect(row.title).toHaveLength(500);
    expect(row.content).toContain('[user] Remember this decision.');
    expect(row.content).not.toContain('ciphertext-must-not-be-searchable');
    expect(row.content).not.toContain('private_future_payload');
    expect(row.raw_archive_manifest).toEqual({
      manifest_path: '/archive/session-1/manifest.json',
      version: 1,
      files: [{ path: '/source/session-1.jsonl', sha256: 'b'.repeat(64) }],
    });
    expect(row['source_data.chat_interchange']).toMatchObject({
      event_count: 3,
      events: [
        expect.objectContaining({ source_event_id: 'event-1' }),
        expect.objectContaining({ source_event_id: 'event-2' }),
        expect.objectContaining({ source_event_id: 'event-3' }),
      ],
      relations: [],
    });
    expect(JSON.stringify(row['source_data.chat_interchange'])).not.toContain('ciphertext-must-not-be-searchable');
    expect(JSON.stringify(row['source_data.chat_interchange'])).not.toContain('private_future_payload');
  });

  it('bounds the searchable conversation projection while retaining archive provenance', () => {
    const conversation = ConversationSchema.parse({
      provider: 'openai_codex',
      surface: 'codex',
      source_conversation_id: 'large-session',
      created_at: '2026-08-10T20:00:00.000Z',
      archived: false,
      source_path: '/source/large-session.jsonl',
      source_sha256: 'c'.repeat(64),
      adapter_name: 'codex-history',
      adapter_version: '1.0.0',
      provider_metadata_json: {
        raw_archive_manifest: {
          manifest_path: '/archive/large-session/manifest.json',
          version: 1,
          files: [{ path: '/source/large-session.jsonl', sha256: 'c'.repeat(64) }],
        },
      },
      events: [{
        sequence: 0,
        source_event_id: 'large-event',
        category: 'message',
        role: 'user',
        provider_type: 'response_item',
        raw_json: { payload: 'raw value must stay in the archive' },
        content_blocks: [{ ordinal: 0, block_type: 'text', text: 'memory '.repeat(100_000) }],
      }],
      relations: [],
    });

    const row = conversationToImportRow(conversation);

    expect(row.content?.length).toBeLessThanOrEqual(512 * 1024);
    expect(JSON.stringify(row['source_data.chat_interchange'])).not.toContain('raw value must stay in the archive');
    expect(row.raw_archive_manifest).toBeDefined();
  });

  it('replaces PostgreSQL-incompatible code points in derived projections', () => {
    const conversation = ConversationSchema.parse({
      provider: 'anthropic_claude',
      surface: 'claude_code',
      source_conversation_id: 'nul-session',
      title: 'NUL\0title\uD800',
      created_at: '2026-08-10T20:00:00.000Z',
      archived: false,
      source_path: '/source/nul-session.jsonl',
      source_sha256: 'd'.repeat(64),
      adapter_name: 'claude-code-history',
      adapter_version: '1.0.0',
      provider_metadata_json: { nested: { value: 'metadata\0value\uDC00' } },
      events: [{
        sequence: 0,
        source_event_id: 'nul-event',
        category: 'message',
        role: 'user',
        provider_type: 'user',
        raw_json: { original: 'retained in raw archive' },
        content_blocks: [{ ordinal: 0, block_type: 'text', text: 'memory\0value' }],
      }],
      relations: [],
    });

    const row = conversationToImportRow(conversation);

    expect(JSON.stringify(row)).not.toContain('\\u0000');
    expect(JSON.stringify(row)).not.toContain('\\ud800');
    expect(JSON.stringify(row)).not.toContain('\\udc00');
    expect(row.title).toBe('NUL�title�');
    expect(row.content).toContain('memory�value');
    expect(row['metadata.provider_metadata_json']).toEqual({
      nested: { value: 'metadata�value�' },
    });
  });
});
