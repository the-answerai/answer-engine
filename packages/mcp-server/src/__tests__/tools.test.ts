import { describe, it, expect, vi } from 'vitest';
import {
  AskQuestionSchema,
  GetContentSchema,
  MAX_CONTENT_CHARS,
  SaveContentSchema,
  InspectMemorySchema,
  ForgetSchema,
  GetContextPackSchema,
  SearchContentSchema,
  SummarizeCollectionSchema,
  handleAskQuestion,
  handleGetContent,
  handleListTags,
  handleSaveContent,
  handleInspectMemory,
  handleForget,
  handleGetContextPack,
  handleSearchContent,
  handleSummarizeCollection,
} from '../tools.js';
import { AnswerEngineClient, ApiError } from '../api-client.js';

// Create a mock client
function createMockClient(overrides: Partial<AnswerEngineClient> = {}): AnswerEngineClient {
  return {
    getSchema: vi.fn(),
    query: vi.fn(),
    retrieve: vi.fn(),
    summarize: vi.fn(),
    ask: vi.fn(),
    saveContent: vi.fn(),
    getLineage: vi.fn(),
    deleteContent: vi.fn(),
    getRecentContent: vi.fn(),
    ...overrides,
  } as unknown as AnswerEngineClient;
}

describe('MCP Tool Handlers', () => {
  describe('library scope schemas', () => {
    it('accept optional library scope fields for agent tools', () => {
      expect(SearchContentSchema.parse({ query: 'test', librarySlug: 'customer-wins' }).librarySlug).toBe('customer-wins');
      expect(GetContentSchema.parse({ ids: ['item-1'], libraryId: 'library-id' }).libraryId).toBe('library-id');
      expect(SummarizeCollectionSchema.parse({ prompt: 'test', librarySlug: 'customer-wins' }).librarySlug).toBe('customer-wins');
      expect(AskQuestionSchema.parse({ question: 'What changed?', librarySlug: 'customer-wins' }).librarySlug).toBe('customer-wins');
      expect(SaveContentSchema.parse({ title: 'Memory', librarySlug: 'personal' }).librarySlug).toBe('personal');
    });
  });

  describe('handleInspectMemory', () => {
    it('formats current and superseded lineage with provenance', async () => {
      const oldId = '11111111-1111-4111-8111-111111111111';
      const currentId = '22222222-2222-4222-8222-222222222222';
      const contentId = '33333333-3333-4333-8333-333333333333';
      const client = createMockClient({
        getLineage: vi.fn().mockResolvedValue({
          data: {
            source: 'codex',
            origin: { sourceUrl: 'https://example.com/thread', externalId: 'thread-7' },
            currentArtifacts: [{ id: currentId }],
            lineage: [{
              artifactType: 'cleaned_text',
              analysisConfigId: null,
              recipeName: null,
              versions: [
                {
                  id: currentId, artifactType: 'cleaned_text', textKind: 'cleaned',
                  status: 'success', supersedesId: oldId, sourceContentIds: [contentId],
                  version: 2, isCurrent: true, analysisConfigId: null, recipeVersion: '2',
                  modelId: 'model-new', promptHash: null, createdAt: '2026-01-02',
                  replacedById: null, replacedByVersion: null,
                },
                {
                  id: oldId, artifactType: 'cleaned_text', textKind: 'cleaned',
                  status: 'superseded', supersedesId: null, sourceContentIds: [contentId],
                  version: 1, isCurrent: false, analysisConfigId: null, recipeVersion: '1',
                  modelId: 'model-old', promptHash: null, createdAt: '2026-01-01',
                  replacedById: currentId, replacedByVersion: 2,
                },
              ],
            }],
          },
        }),
      });

      const result = await handleInspectMemory(client, InspectMemorySchema.parse({ contentId }));

      expect(result).toContain('Source:** codex');
      expect(result).toContain('v2 [CURRENT] is_current=true');
      expect(result).toContain('v1 [SUPERSEDED] is_current=false');
      expect(result).toContain('replaced by v2');
      expect(result).toContain(`source_content_ids=${contentId}`);
    });

    it('propagates lineage API errors', async () => {
      const client = createMockClient({
        getLineage: vi.fn().mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Content not found')),
      });
      await expect(handleInspectMemory(client, {
        contentId: '33333333-3333-4333-8333-333333333333',
      })).rejects.toThrow(ApiError);
    });
  });

  describe('handleForget', () => {
    const memoryId = '44444444-4444-4444-8444-444444444444';

    it('soft-removes a memory by id and confirms it is not permanently erased', async () => {
      const deleteContent = vi.fn().mockResolvedValue({
        success: true,
        data: null,
      });
      const client = createMockClient({ deleteContent });

      const result = await handleForget(client, ForgetSchema.parse({ id: memoryId }));

      expect(deleteContent).toHaveBeenCalledWith(memoryId);
      expect(result).toContain(memoryId);
      expect(result).toContain('soft-removed');
      expect(result).toContain('not permanently erased');
    });

    it('propagates a 404 instead of silently no-oping on a missing id', async () => {
      const client = createMockClient({
        deleteContent: vi.fn().mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Content not found')),
      });
      await expect(handleForget(client, { id: memoryId })).rejects.toThrow(ApiError);
    });
  });

  describe('handleGetContextPack', () => {
    function queryItem(id: string, relevanceScore: number, summary: string) {
      return {
        id,
        title: `Memory ${id}`,
        contentType: 'chat',
        textKind: 'compatibility' as const,
        relevanceScore,
        summary,
        tags: [],
        createdAt: '2026-01-01',
      };
    }

    it('bundles memories with citations and reports the total', async () => {
      const query = vi.fn().mockResolvedValue({
        data: {
          results: [queryItem('a', 0.91, 'First memory'), queryItem('b', 0.72, 'Second memory')],
          total: 2,
          searchType: 'hybrid',
        },
      });
      const client = createMockClient({ query });

      const result = await handleGetContextPack(
        client,
        GetContextPackSchema.parse({ query: 'what did we decide' }),
      );

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({ include: ['summary'], limit: 8, searchType: 'hybrid' }),
      );
      expect(result).toContain('Context Pack');
      expect(result).toContain('Included 2 of 2 memories');
      expect(result).toContain('Citations: a, b');
    });

    it('respects the character budget by dropping lower-relevance items', async () => {
      const query = vi.fn().mockResolvedValue({
        data: {
          results: [
            queryItem('a', 0.91, 'x'.repeat(200)),
            queryItem('b', 0.72, 'y'.repeat(200)),
            queryItem('c', 0.51, 'z'.repeat(200)),
          ],
          total: 3,
          searchType: 'hybrid',
        },
      });
      const client = createMockClient({ query });

      const result = await handleGetContextPack(
        client,
        GetContextPackSchema.parse({ query: 'budgeted', maxChars: 500 }),
      );

      expect(result).toContain('dropped to fit');
      expect(result).not.toContain('Citations: a, b, c');
    });

    it('reports when no memories are relevant', async () => {
      const client = createMockClient({
        query: vi.fn().mockResolvedValue({
          data: { results: [], total: 0, searchType: 'hybrid' },
        }),
      });

      const result = await handleGetContextPack(client, GetContextPackSchema.parse({ query: 'nothing' }));
      expect(result).toContain('No relevant memories found');
    });
  });

  describe('handleSearchContent', () => {
    it('returns formatted results', async () => {
      const client = createMockClient({
        query: vi.fn().mockResolvedValue({
          data: {
            results: [
              {
                id: '1',
                title: 'Test',
                contentType: 'page',
                textKind: 'compatibility',
                relevanceScore: 0.95,
                tags: [{ label: 'Tag1', slug: 'tag1', category: null }],
                summary: null,
                createdAt: '2024-01-01',
              },
            ],
            total: 1,
            searchType: 'hybrid',
          },
        }),
      });

      const result = await handleSearchContent(client, {
        query: 'test',
        searchType: 'hybrid',
        limit: 10,
        include: ['summary'],
      });
      expect(result).toContain('Search Results');
      expect(result).toContain('Test');
      expect(result).toContain('0.950');
    });

    it('prepends active library scope when present', async () => {
      const client = createMockClient({
        query: vi.fn().mockResolvedValue({
          data: {
            results: [],
            total: 0,
            searchType: 'hybrid',
            scope: {
              type: 'library',
              libraryId: 'library-1',
              librarySlug: 'customer-wins',
              libraryName: 'Customer Wins',
              itemCount: 7,
            },
          },
        }),
      });

      const result = await handleSearchContent(client, {
        query: 'test',
        searchType: 'hybrid',
        limit: 10,
        include: ['summary'],
      });

      expect(result).toMatch(/^Scope: library "customer-wins" \(7 items\)/);
    });

    it('returns no results message', async () => {
      const client = createMockClient({
        query: vi.fn().mockResolvedValue({
          data: { results: [], total: 0, searchType: 'hybrid' },
        }),
      });

      const result = await handleSearchContent(client, {
        query: 'nothing',
        searchType: 'hybrid',
        limit: 10,
        include: ['summary'],
      });
      expect(result).toContain('No results found');
    });

    it('propagates ApiError', async () => {
      const client = createMockClient({
        query: vi.fn().mockRejectedValue(new ApiError(401, 'INVALID_API_KEY', 'Bad key')),
      });

      await expect(
        handleSearchContent(client, {
          query: 'test',
          searchType: 'hybrid',
          limit: 10,
          include: [],
        })
      ).rejects.toThrow(ApiError);
    });

    it('includes summaries in output', async () => {
      const client = createMockClient({
        query: vi.fn().mockResolvedValue({
          data: {
            results: [
              {
                id: '2',
                title: 'Tagged Article',
                contentType: 'article',
                textKind: 'compatibility',
                relevanceScore: 0.8,
                tags: [
                  { label: 'Engineering', slug: 'engineering', category: 'dept' },
                  { label: 'Backend', slug: 'backend', category: 'dept' },
                ],
                summary: 'A great article',
                createdAt: '2024-06-01',
              },
            ],
            total: 1,
            searchType: 'fulltext',
          },
        }),
      });

      const result = await handleSearchContent(client, {
        query: 'engineering',
        searchType: 'fulltext',
        limit: 5,
        include: ['summary'],
      });
      expect(result).toContain('A great article');
    });
  });

  describe('handleGetContent', () => {
    it('returns formatted items', async () => {
      const client = createMockClient({
        retrieve: vi.fn().mockResolvedValue({
          data: {
            items: [
              {
                id: 'abc-123',
                title: 'My Page',
                contentType: 'page',
                textKind: 'compatibility',
                createdAt: '2024-01-01',
                updatedAt: '2024-01-02',
                sourceUrl: 'https://example.com/page',
                summary: 'A summary',
                tags: [],
                content: 'Full content here',
                children: [],
              },
            ],
          },
        }),
      });

      const result = await handleGetContent(client, {
        ids: ['abc-123'],
        include: ['content', 'summary'],
      });
      expect(result).toContain('My Page');
      expect(result).toContain('https://example.com/page');
      expect(result).toContain('Full content here');
      expect(result).toContain('Text kind');
    });

    it('prepends active library scope when present', async () => {
      const client = createMockClient({
        retrieve: vi.fn().mockResolvedValue({
          data: {
            items: [],
            scope: {
              type: 'library',
              libraryId: 'library-1',
              librarySlug: 'customer-wins',
              libraryName: 'Customer Wins',
              itemCount: 7,
            },
          },
        }),
      });

      const result = await handleGetContent(client, {
        ids: ['abc-123'],
        include: ['summary'],
      });

      expect(result).toMatch(/^Scope: library "customer-wins" \(7 items\)/);
    });

    it('returns no items message when empty', async () => {
      const client = createMockClient({
        retrieve: vi.fn().mockResolvedValue({
          data: { items: [] },
        }),
      });

      const result = await handleGetContent(client, {
        ids: ['missing-id'],
        include: ['summary'],
      });
      expect(result).toContain('No items found');
    });

    it('propagates ApiError', async () => {
      const client = createMockClient({
        retrieve: vi.fn().mockRejectedValue(new ApiError(503, 'MODEL_UNAVAILABLE', 'Model unavailable')),
      });

      await expect(
        handleGetContent(client, {
          ids: ['id-1'],
          include: ['content'],
        })
      ).rejects.toThrow(ApiError);
    });
  });

  describe('handleListTags', () => {
    it('groups tags by category', async () => {
      const client = createMockClient({
        getSchema: vi.fn().mockResolvedValue({
          data: {
            contentTypes: { page: 5, article: 3 },
            tags: [
              { slug: 'a', label: 'A', category: 'cat1', description: 'desc' },
              { slug: 'b', label: 'B', category: 'cat1', description: null },
              { slug: 'c', label: 'C', category: null, description: null },
            ],
            capabilities: ['search', 'retrieve'],
            dateRange: { earliest: '2024-01-01', latest: '2024-12-31' },
          },
        }),
      });

      const result = await handleListTags(client);
      expect(result).toContain('cat1');
      expect(result).toContain('uncategorized');
      expect(result).toContain('page');
      expect(result).toContain('article');
      expect(result).toContain('search, retrieve');
      expect(result).toContain('2024-01-01');
    });

    it('includes tag descriptions when present', async () => {
      const client = createMockClient({
        getSchema: vi.fn().mockResolvedValue({
          data: {
            contentTypes: {},
            tags: [
              { slug: 'tech', label: 'Technology', category: 'topic', description: 'Tech articles' },
            ],
            capabilities: [],
            dateRange: { earliest: null, latest: null },
          },
        }),
      });

      const result = await handleListTags(client);
      expect(result).toContain('Tech articles');
      expect(result).toContain('Technology');
    });

    it('propagates ApiError', async () => {
      const client = createMockClient({
        getSchema: vi.fn().mockRejectedValue(new ApiError(429, 'RATE_LIMIT', 'Too many requests')),
      });

      await expect(handleListTags(client)).rejects.toThrow(ApiError);
    });
  });

  describe('handleSummarizeCollection', () => {
    it('prepends active library scope when present', async () => {
      const client = createMockClient({
        summarize: vi.fn().mockResolvedValue({
          data: {
            summary: 'Scoped summary',
            sourceCount: 3,
            scope: {
              type: 'library',
              libraryId: 'library-1',
              librarySlug: 'customer-wins',
              libraryName: 'Customer Wins',
              itemCount: 7,
            },
          },
        }),
      });

      const result = await handleSummarizeCollection(client, {
        prompt: 'summarize',
        limit: 20,
      });

      expect(result).toMatch(/^Scope: library "customer-wins" \(7 items\)/);
      expect(result).toContain('Scoped summary');
    });
  });

  describe('handleAskQuestion', () => {
    it('returns formatted answer and citations with scope and metadata', async () => {
      const client = createMockClient({
        ask: vi.fn().mockResolvedValue({
          data: {
            answer: 'Customers need grounded discovery notes.',
            citations: [
              {
                contentId: '00000000-0000-0000-0000-000000000001',
                title: 'Customer Discovery Call',
                contentType: 'call',
                relevanceScore: 0.8765,
                excerpt: 'The buyer asked for citations from discovery calls.',
              },
            ],
            modelId: 'test-model',
            provider: 'openai',
            retrievalMode: 'hybrid',
            responseStyle: 'cited',
            scope: {
              type: 'library',
              libraryId: 'library-1',
              librarySlug: 'customer-wins',
              libraryName: 'Customer Wins',
              itemCount: 7,
            },
          },
        }),
      });

      const result = await handleAskQuestion(
        client,
        AskQuestionSchema.parse({
          question: 'What do customers need?',
          retrievalMode: 'hybrid',
          responseStyle: 'cited',
          librarySlug: 'customer-wins',
          conversationId: 'conv-1',
          sourceAgentId: 'codex',
        }),
      );

      expect(client.ask).toHaveBeenCalledWith(
        expect.objectContaining({
          question: 'What do customers need?',
          retrievalMode: 'hybrid',
          responseStyle: 'cited',
          librarySlug: 'customer-wins',
          conversationId: 'conv-1',
          sourceAgentId: 'codex',
        }),
      );
      expect(result).toMatch(/^Scope: library "customer-wins" \(7 items\)/);
      expect(result).toContain('Customers need grounded discovery notes.');
      expect(result).toContain('Customer Discovery Call');
      expect(result).toContain('00000000-0000-0000-0000-000000000001');
      expect(result).toContain('0.876');
      expect(result).toContain('Model: test-model | Provider: openai | Retrieval: hybrid | Style: cited');
    });
  });

  describe('handleSaveContent', () => {
    it('rejects oversized content at the schema boundary', () => {
      expect(() =>
        SaveContentSchema.parse({
          title: 'Too Large',
          content: 'x'.repeat(MAX_CONTENT_CHARS + 1),
        }),
      ).toThrow(/content exceeds the maximum allowed length/);
    });

    it('normalizes single-item camelCase input and returns saved ids', async () => {
      const client = createMockClient({
        saveContent: vi.fn().mockResolvedValue({
          data: {
            contentIds: ['content-1'],
            items: [
              {
                rowIndex: 0,
                id: 'content-1',
                contentType: 'chat',
                sourceIdentifier: 'codex-chat-1',
                title: 'Codex Chat',
              },
            ],
            totalItems: 1,
            completedItems: 1,
            failedItems: 0,
            failures: [],
            parseErrors: [],
            requiresIdForIdempotency: false,
            scope: {
              type: 'library',
              libraryId: 'library-1',
              librarySlug: 'personal',
              libraryName: 'Personal',
              itemCount: 1,
            },
          },
        }),
      });

      const result = await handleSaveContent(
        client,
        SaveContentSchema.parse({
          title: 'Codex Chat',
          content: 'Important project context',
          sourceIdentifier: 'codex-chat-1',
          source: 'codex',
          sourceAgentId: 'codex',
          conversationId: 'chat-1',
          turnIndex: 1,
          turnRole: 'assistant',
          turnTimestamp: '2026-06-01T12:01:00.000Z',
          turnMetadata: { model: 'gpt-test' },
          metadata: { project: 'answer-engine' },
          librarySlug: 'personal',
        }),
      );

      expect(client.saveContent).toHaveBeenCalledWith({
        libraryId: undefined,
        librarySlug: 'personal',
        options: { forceStore: true },
        items: [
          {
            title: 'Codex Chat',
            content: 'Important project context',
            content_type: 'chat',
            source_identifier: 'codex-chat-1',
            source: 'codex',
            source_agent_id: 'codex',
            conversation_id: 'chat-1',
            turn_index: 1,
            turn_role: 'assistant',
            turn_timestamp: '2026-06-01T12:01:00.000Z',
            turn_metadata: { model: 'gpt-test' },
            metadata: { project: 'answer-engine' },
          },
        ],
      });
      expect(result).toMatch(/^Scope: library "personal" \(1 items\)/);
      expect(result).toContain('Content Saved');
      expect(result).toContain('content-1');
      expect(result).not.toContain('not idempotent');
    });

    it('normalizes analysisData for save_content', async () => {
      const analysisData = {
        extraction: {
          document_id: '605',
          extracted_cells: [{ section: 'base_bid', value: 100000 }],
          vendor_review: { status: 'approved' },
        },
      };
      const client = createMockClient({
        saveContent: vi.fn().mockResolvedValue({
          data: {
            contentIds: ['content-document-1'],
            items: [
              {
                rowIndex: 0,
                id: 'content-document-1',
                contentType: 'document',
                sourceIdentifier: 'customer-document-605',
                title: 'Civic Center - 23 - Acme Mechanical',
              },
            ],
            totalItems: 1,
            completedItems: 1,
            failedItems: 0,
            failures: [],
            parseErrors: [],
            requiresIdForIdempotency: false,
          },
        }),
      });

      const result = await handleSaveContent(
        client,
        SaveContentSchema.parse({
          title: 'Civic Center - 23 - Acme Mechanical',
          contentType: 'document',
          content: '# Proposal',
          sourceIdentifier: 'customer-document-605',
          source: 'customer-documents',
          analysisData,
        }),
      );

      expect(client.saveContent).toHaveBeenCalledWith({
        libraryId: undefined,
        librarySlug: undefined,
        options: { forceStore: true },
        items: [
          {
            title: 'Civic Center - 23 - Acme Mechanical',
            content: '# Proposal',
            content_type: 'document',
            source_identifier: 'customer-document-605',
            source: 'customer-documents',
            analysis_data: analysisData,
          },
        ],
      });
      expect(result).toContain('content-document-1');
    });

    it('formats idempotency warnings for generated source identifiers', async () => {
      const client = createMockClient({
        saveContent: vi.fn().mockResolvedValue({
          data: {
            contentIds: ['content-2'],
            items: [
              {
                rowIndex: 0,
                id: 'content-2',
                contentType: 'chat',
                sourceIdentifier: 'manual-generated',
                title: 'Loose Memory',
              },
            ],
            totalItems: 1,
            completedItems: 1,
            failedItems: 0,
            failures: [],
            parseErrors: [],
            requiresIdForIdempotency: true,
          },
        }),
      });

      const result = await handleSaveContent(
        client,
        SaveContentSchema.parse({
          title: 'Loose Memory',
          content: 'No source id supplied',
        }),
      );

      expect(client.saveContent).toHaveBeenCalledWith({
        libraryId: undefined,
        librarySlug: undefined,
        options: { forceStore: true },
        items: [
          {
            title: 'Loose Memory',
            content: 'No source id supplied',
            content_type: 'chat',
          },
        ],
      });
      expect(result).toContain('not idempotent');
    });
  });

});
