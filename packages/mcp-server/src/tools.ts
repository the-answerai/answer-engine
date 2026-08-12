/**
 * MCP Tool Definitions
 * Maps Answer Engine API endpoints to MCP tools with Zod input schemas
 */

import { z } from 'zod';
import {
  AnswerEngineClient,
  type ContentArtifactLineageVersion,
  type LibraryScope,
  type SaveContentContentType,
  type SaveContentImportRow,
} from './api-client.js';

const SaveContentContentTypeSchema = z.enum([
  'call',
  'document',
  'ticket',
  'chat',
  'page',
]);

const SourceAgentIdSchema = z
  .enum(['claude', 'codex', 'cowork', 'local_dir'])
  .describe('Canonical source-agent registry id');

const ConversationIdSchema = z.string().trim().min(1).max(512);

const TurnRoleSchema = z.enum(['user', 'assistant', 'system', 'tool', 'developer', 'other']);

const TurnTimestampSchema = z.string().datetime();

export const MAX_CONTENT_CHARS = 5 * 1024 * 1024;
export const MAX_CONTENT_SIZE_LABEL = '5 MiB';

// -----------------------------------------------------------------------
// Input schemas (ZodObject so we can expose .shape to the MCP SDK)
// -----------------------------------------------------------------------

export const SearchContentSchema = z.object({
  query: z.string().describe('Search query text'),
  libraryId: z.string().optional().describe('Optional library UUID to scope the search'),
  librarySlug: z.string().optional().describe('Optional library slug to scope the search'),
  conversationId: ConversationIdSchema.optional().describe('Optional chat conversation/thread id to scope search'),
  sourceAgentId: SourceAgentIdSchema.optional().describe('Optional source-agent id to scope search'),
  searchType: z
    .enum(['fulltext', 'semantic', 'hybrid'])
    .default('hybrid')
    .describe('Search algorithm to use'),
  filters: z
    .object({
      contentTypes: z.array(SaveContentContentTypeSchema).optional().describe('Filter by content types'),
      tags: z.array(z.string()).optional().describe('Filter by tag slugs'),
      dateFrom: z.string().datetime().optional().describe('Filter: created after this ISO timestamp'),
      dateTo: z.string().datetime().optional().describe('Filter: created before this ISO timestamp'),
    })
    .optional()
    .describe('Optional filters to narrow results'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum number of results'),
  include: z
    .array(z.enum(['summary', 'content', 'metadata']))
    .default(['summary'])
    .describe('Fields to include in results'),
});

export const GetContentSchema = z.object({
  ids: z.array(z.string()).min(1).max(50).optional().describe('Content item UUIDs to retrieve'),
  libraryId: z.string().optional().describe('Optional library UUID to scope the retrieval'),
  librarySlug: z.string().optional().describe('Optional library slug to scope the retrieval'),
  conversationId: ConversationIdSchema.optional().describe('Optional chat conversation/thread id to retrieve as ordered turns'),
  sourceAgentId: SourceAgentIdSchema.optional().describe('Optional source-agent id for conversation retrieval'),
  include: z
    .array(z.enum(['summary', 'content', 'metadata']))
    .default(['summary', 'content', 'metadata'])
    .describe('Fields to include in retrieved content.'),
});

export const SummarizeCollectionSchema = z.object({
  prompt: z.string().describe('What to summarize or analyze about the content'),
  libraryId: z.string().optional().describe('Optional library UUID to scope the summary'),
  librarySlug: z.string().optional().describe('Optional library slug to scope the summary'),
  filter: z
    .object({
      contentTypes: z.array(SaveContentContentTypeSchema).optional(),
      tags: z.array(z.string()).optional(),
      dateFrom: z.string().datetime().optional(),
      dateTo: z.string().datetime().optional(),
    })
    .optional()
    .describe('Filter which content to include in the summary'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Max content items to analyze'),
});

export const AskQuestionSchema = z.object({
  question: z.string().min(3).max(2000).describe('Question to answer using grounded RAG'),
  contentIds: z
    .array(z.string().uuid())
    .optional()
    .describe('Optional content item UUIDs to restrict fulltext retrieval'),
  libraryId: z.string().uuid().optional().describe('Optional library UUID to scope retrieval'),
  librarySlug: z.string().min(1).max(120).optional().describe('Optional library slug to scope retrieval'),
  conversationId: ConversationIdSchema.optional().describe('Optional chat conversation/thread id to scope retrieval'),
  sourceAgentId: SourceAgentIdSchema.optional().describe('Optional source-agent id to scope retrieval'),
  retrievalMode: z
    .enum(['fulltext', 'semantic', 'hybrid'])
    .default('hybrid')
    .describe('Retrieval strategy for finding evidence'),
  responseStyle: z
    .enum(['cited', 'conversational'])
    .default('cited')
    .describe('Answer style to request from the RAG synthesizer'),
  filters: z
    .object({
      contentTypes: z.array(SaveContentContentTypeSchema).optional().describe('Filter by content types'),
      tagSlugs: z.array(z.string()).optional().describe('Filter by tag slugs'),
      dateFrom: z.string().datetime().optional().describe('Filter: created after this ISO timestamp'),
      dateTo: z.string().datetime().optional().describe('Filter: created before this ISO timestamp'),
    })
    .optional()
    .describe('Optional filters to narrow retrieval'),
});

const SaveContentItemSchema = z.object({
  title: z.string().min(1).max(500).describe('Title for the memory/content item'),
  content: z
    .string()
    .min(1)
    .max(MAX_CONTENT_CHARS, `content exceeds the maximum allowed length (${MAX_CONTENT_SIZE_LABEL})`)
    .optional()
    .describe('Text content to save'),
  contentType: SaveContentContentTypeSchema
    .default('chat')
    .describe('Answer Engine content type; defaults to chat for personal memory'),
  sourceIdentifier: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe('Caller-stable idempotency key. Reusing it updates the same content item.'),
  source: z.string().min(1).max(120).optional().describe('Source system label'),
  sourceAgentId: SourceAgentIdSchema.optional(),
  conversationId: ConversationIdSchema.optional(),
  turnIndex: z.number().int().min(0).optional(),
  turnRole: TurnRoleSchema.optional(),
  turnTimestamp: TurnTimestampSchema.optional(),
  turnMetadata: z.record(z.unknown()).optional(),
  externalUrl: z.string().min(1).max(2048).optional().describe('Optional source URL'),
  metadata: z.record(z.unknown()).optional().describe('Optional metadata object'),
  analysisData: z.record(z.unknown()).optional().describe('Optional structured analysis_data object'),
  sourceData: z.record(z.unknown()).optional().describe('Optional original source payload'),
});

export const SaveContentSchema = z.object({
  libraryId: z.string().uuid().optional().describe('Optional library UUID to save into'),
  librarySlug: z.string().min(1).max(120).optional().describe('Optional library slug to save into'),
  items: z
    .array(SaveContentItemSchema)
    .min(1)
    .max(25)
    .optional()
    .describe('Small batch of content items to save. Max 25 items.'),
  title: z.string().min(1).max(500).optional().describe('Single-item title when items is omitted'),
  content: z
    .string()
    .min(1)
    .max(MAX_CONTENT_CHARS, `content exceeds the maximum allowed length (${MAX_CONTENT_SIZE_LABEL})`)
    .optional()
    .describe('Single-item text content when items is omitted'),
  contentType: SaveContentContentTypeSchema
    .default('chat')
    .describe('Single-item content type; defaults to chat'),
  sourceIdentifier: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe('Single-item caller-stable idempotency key'),
  source: z.string().min(1).max(120).optional().describe('Single-item source system label'),
  sourceAgentId: SourceAgentIdSchema.optional().describe('Single-item source-agent registry id'),
  conversationId: ConversationIdSchema.optional().describe('Single-item chat conversation/thread id'),
  turnIndex: z.number().int().min(0).optional().describe('Single-item turn order within the conversation'),
  turnRole: TurnRoleSchema.optional().describe('Single-item chat role'),
  turnTimestamp: TurnTimestampSchema.optional().describe('Single-item source timestamp'),
  turnMetadata: z.record(z.unknown()).optional().describe('Single-item per-turn metadata object'),
  externalUrl: z.string().min(1).max(2048).optional().describe('Single-item source URL'),
  metadata: z.record(z.unknown()).optional().describe('Single-item metadata object'),
  analysisData: z.record(z.unknown()).optional().describe('Single-item structured analysis_data object'),
  sourceData: z.record(z.unknown()).optional().describe('Single-item original source payload'),
});

export const InspectMemorySchema = z.object({
  contentId: z.string().uuid().describe('Content/memory UUID to inspect'),
});

export const ForgetSchema = z.object({
  id: z
    .string()
    .uuid()
    .describe('Memory/content UUID to forget. Soft-removes it so recall/search no longer return it.'),
});

export const GetContextPackSchema = z.object({
  query: z.string().min(1).max(2000).describe('Task or question to gather relevant memory for'),
  libraryId: z.string().uuid().optional().describe('Optional library UUID to scope the pack'),
  librarySlug: z.string().min(1).max(120).optional().describe('Optional library slug to scope the pack'),
  conversationId: ConversationIdSchema.optional().describe('Optional chat conversation/thread id to scope the pack'),
  sourceAgentId: SourceAgentIdSchema.optional().describe('Optional source-agent id to scope the pack'),
  searchType: z
    .enum(['fulltext', 'semantic', 'hybrid'])
    .default('hybrid')
    .describe('Retrieval strategy used to gather memories'),
  maxItems: z
    .number()
    .int()
    .min(1)
    .max(25)
    .default(8)
    .describe('Maximum memories to include in the pack'),
  maxChars: z
    .number()
    .int()
    .min(500)
    .max(50000)
    .default(8000)
    .describe('Character budget for the pack body; lower-relevance items are dropped to fit'),
});

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function formatScope(scope: LibraryScope | undefined): string {
  if (!scope) return '';
  return `Scope: library "${scope.librarySlug}" (${scope.itemCount} items)\n\n`;
}

function formatLineageVersion(version: ContentArtifactLineageVersion): string {
  const state = version.isCurrent
    ? 'CURRENT'
    : version.status === 'superseded'
      ? 'SUPERSEDED'
      : version.status.toUpperCase();
  let output = `- v${version.version} [${state}] is_current=${version.isCurrent}`;
  output += ` | status=${version.status} | id=${version.id}`;
  if (version.supersedesId) output += ` | supersedes=${version.supersedesId}`;
  if (version.replacedByVersion !== null) {
    output += ` | replaced by v${version.replacedByVersion} (${version.replacedById})`;
  }
  if (version.sourceContentIds.length > 0) {
    output += ` | source_content_ids=${version.sourceContentIds.join(',')}`;
  }
  if (version.modelId) output += ` | model=${version.modelId}`;
  if (version.recipeVersion) output += ` | recipe=${version.recipeVersion}`;
  return `${output}\n`;
}

interface SaveContentItemCandidate {
  title?: string;
  content?: string;
  contentType?: SaveContentContentType;
  sourceIdentifier?: string;
  source?: string;
  sourceAgentId?: string;
  conversationId?: string;
  turnIndex?: number;
  turnRole?: 'user' | 'assistant' | 'system' | 'tool' | 'developer' | 'other';
  turnTimestamp?: string;
  turnMetadata?: Record<string, unknown>;
  externalUrl?: string;
  metadata?: Record<string, unknown>;
  analysisData?: Record<string, unknown>;
  sourceData?: Record<string, unknown>;
}

function normalizeSaveContentItem(
  item: SaveContentItemCandidate,
  index: number,
): SaveContentImportRow {
  const title = item.title?.trim();
  if (!title) {
    throw new Error(`items.${index}.title is required`);
  }

  const row: SaveContentImportRow = {
    title,
    content_type: item.contentType ?? 'chat',
  };

  if (item.content !== undefined) row.content = item.content;
  if (item.sourceIdentifier) row.source_identifier = item.sourceIdentifier;
  if (item.source) row.source = item.source;
  if (item.sourceAgentId) row.source_agent_id = item.sourceAgentId;
  if (item.conversationId) row.conversation_id = item.conversationId;
  if (item.turnIndex !== undefined) row.turn_index = item.turnIndex;
  if (item.turnRole) row.turn_role = item.turnRole;
  if (item.turnTimestamp) row.turn_timestamp = item.turnTimestamp;
  if (item.turnMetadata) row.turn_metadata = item.turnMetadata;
  if (item.externalUrl) row.external_url = item.externalUrl;
  if (item.metadata) row.metadata = item.metadata;
  if (item.analysisData) row.analysis_data = item.analysisData;
  if (item.sourceData) row.source_data = item.sourceData;
  return row;
}

function normalizeSaveContentInput(
  input: z.infer<typeof SaveContentSchema>,
): SaveContentImportRow[] {
  const items = input.items ?? [
    {
      title: input.title,
      content: input.content,
      contentType: input.contentType,
      sourceIdentifier: input.sourceIdentifier,
      source: input.source,
      sourceAgentId: input.sourceAgentId,
      conversationId: input.conversationId,
      turnIndex: input.turnIndex,
      turnRole: input.turnRole,
      turnTimestamp: input.turnTimestamp,
      turnMetadata: input.turnMetadata,
      externalUrl: input.externalUrl,
      metadata: input.metadata,
      analysisData: input.analysisData,
      sourceData: input.sourceData,
    },
  ];

  return items.map((item, index) => normalizeSaveContentItem(item, index));
}

// -----------------------------------------------------------------------
// Tool handlers
// -----------------------------------------------------------------------

export async function handleSearchContent(
  client: AnswerEngineClient,
  input: z.infer<typeof SearchContentSchema>
): Promise<string> {
  const response = await client.query(input);
  const { results, total, searchType } = response.data;

  if (results.length === 0) {
    return `${formatScope(response.data.scope)}No results found for "${input.query}" (${searchType} search).`;
  }

  let output = `${formatScope(response.data.scope)}## Search Results (${total} total, showing ${results.length}, ${searchType})\n\n`;
  for (const item of results) {
    output += `### ${item.title}\n`;
    output += `- **ID:** ${item.id}\n`;
    output += `- **Type:** ${item.contentType}\n`;
    output += `- **Text kind:** ${item.textKind}\n`;
    output += `- **Relevance:** ${item.relevanceScore.toFixed(3)}\n`;
    if (item.summary) output += `- **Summary:** ${item.summary}\n`;
    output += '\n';
  }
  return output;
}

export async function handleGetContent(
  client: AnswerEngineClient,
  input: z.infer<typeof GetContentSchema>
): Promise<string> {
  if (!input.ids?.length && !input.conversationId) {
    throw new Error('Provide ids or conversationId');
  }
  if (input.ids?.length && input.conversationId) {
    throw new Error('Provide either ids or conversationId, not both');
  }

  const response = await client.retrieve(input);
  const { items } = response.data;

  if (items.length === 0) {
    return `${formatScope(response.data.scope)}No items found for the provided IDs.`;
  }

  let output = `${formatScope(response.data.scope)}## Retrieved ${items.length} Item(s)\n\n`;
  for (const item of items) {
    output += `### ${item.title}\n`;
    output += `- **ID:** ${item.id}\n`;
    output += `- **Type:** ${item.contentType}\n`;
    output += `- **Text kind:** ${item.textKind}\n`;
    output += `- **Created:** ${item.createdAt}\n`;
    if (item.sourceUrl) output += `- **URL:** ${item.sourceUrl}\n`;
    if (item.summary) output += `- **Summary:** ${item.summary}\n`;
    if (item.content) output += `\n${item.content}\n`;
    output += '\n';
  }
  return output;
}

export async function handleListTags(client: AnswerEngineClient): Promise<string> {
  const response = await client.getSchema();
  const { contentTypes, tags, capabilities, dateRange } = response.data;

  let output = '## Content Schema\n\n';
  output += '### Content Types\n';
  for (const [type, count] of Object.entries(contentTypes)) {
    output += `- **${type}:** ${count} items\n`;
  }

  output += `\n### Tags (${tags.length} total)\n`;
  const byCategory: Record<string, typeof tags> = {};
  for (const tag of tags) {
    const cat = tag.category ?? 'uncategorized';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(tag);
  }
  for (const [category, categoryTags] of Object.entries(byCategory)) {
    output += `\n**${category}:**\n`;
    for (const tag of categoryTags) {
      output += `- ${tag.label} (\`${tag.slug}\`)`;
      if (tag.description) output += ` — ${tag.description}`;
      output += '\n';
    }
  }

  output += `\n### Capabilities\n${capabilities.join(', ')}\n`;
  output += `\n### Date Range\n${dateRange.earliest ?? 'n/a'} -> ${dateRange.latest ?? 'n/a'}\n`;
  return output;
}

export async function handleSummarizeCollection(
  client: AnswerEngineClient,
  input: z.infer<typeof SummarizeCollectionSchema>
): Promise<string> {
  const response = await client.summarize(input);
  const { summary, sourceCount } = response.data;

  let output = `${formatScope(response.data.scope)}## Summary (${sourceCount} sources analyzed)\n\n`;
  output += summary;
  return output;
}

export async function handleAskQuestion(
  client: AnswerEngineClient,
  input: z.infer<typeof AskQuestionSchema>
): Promise<string> {
  const response = await client.ask(input);
  const { answer, citations, modelId, provider, retrievalMode, responseStyle } = response.data;

  let output = `${formatScope(response.data.scope)}## Answer\n\n`;
  output += answer;
  output += `\n\n## Citations (${citations.length})\n\n`;

  if (citations.length === 0) {
    output += 'No citations returned.\n';
  } else {
    for (const citation of citations) {
      output += `### ${citation.title}\n`;
      output += `- **ID:** ${citation.contentId}\n`;
      output += `- **Type:** ${citation.contentType}\n`;
      output += `- **Relevance:** ${citation.relevanceScore.toFixed(3)}\n`;
      if (citation.excerpt) output += `\n${citation.excerpt}\n`;
      output += '\n';
    }
  }

  output += `\n---\nModel: ${modelId ?? 'default'}`;
  if (provider) output += ` | Provider: ${provider}`;
  output += ` | Retrieval: ${retrievalMode} | Style: ${responseStyle}`;
  return output;
}

export async function handleSaveContent(
  client: AnswerEngineClient,
  input: z.infer<typeof SaveContentSchema>
): Promise<string> {
  const rows = normalizeSaveContentInput(input);
  const response = await client.saveContent({
    items: rows,
    libraryId: input.libraryId,
    librarySlug: input.librarySlug,
    options: { forceStore: true },
  });
  const result = response.data;

  let output = `${formatScope(result.scope)}## Content Saved\n\n`;
  output += `- **Saved:** ${result.completedItems}/${result.totalItems}\n`;
  output += `- **Failed:** ${result.failedItems}\n`;

  if (result.items.length > 0) {
    output += '\n### IDs\n';
    for (const item of result.items) {
      output += `- ${item.id} -- ${item.title} (${item.sourceIdentifier})\n`;
    }
  }

  if (result.requiresIdForIdempotency) {
    output += '\n> Some items did not include sourceIdentifier. Retries for those items are not idempotent.\n';
  }

  if (result.parseErrors.length > 0) {
    output += '\n### Parse Warnings\n';
    for (const error of result.parseErrors) {
      output += `- Row ${error.rowIndex}${error.col ? ` ${error.col}` : ''}: ${error.error}\n`;
    }
  }

  if (result.failures.length > 0) {
    output += '\n### Failed Rows\n';
    for (const failure of result.failures) {
      output += `- Row ${failure.rowIndex} (${failure.sourceIdentifier}): ${failure.error}\n`;
    }
  }

  return output;
}

export async function handleInspectMemory(
  client: AnswerEngineClient,
  input: z.infer<typeof InspectMemorySchema>
): Promise<string> {
  const response = await client.getLineage(input.contentId);
  const result = response.data;

  let output = '## Memory Inspection\n\n';
  output += `- **Content ID:** ${input.contentId}\n`;
  output += `- **Source:** ${result.source ?? 'unknown'}\n`;
  if (result.origin.externalId) output += `- **External ID:** ${result.origin.externalId}\n`;
  if (result.origin.sourceUrl) output += `- **Source URL:** ${result.origin.sourceUrl}\n`;
  output += `- **Current artifacts:** ${result.currentArtifacts.length}\n`;

  if (result.lineage.length === 0) {
    return `${output}\nNo artifact lineage exists for this memory.`;
  }

  output += '\n## Lineage\n\n';
  for (const group of result.lineage) {
    output += `### ${group.artifactType}`;
    if (group.recipeName) output += ` — ${group.recipeName}`;
    output += '\n';
    for (const version of group.versions) {
      output += formatLineageVersion(version);
    }
    output += '\n';
  }
  return output.trimEnd();
}

export async function handleForget(
  client: AnswerEngineClient,
  input: z.infer<typeof ForgetSchema>
): Promise<string> {
  await client.deleteContent(input.id);
  return (
    `## Forgotten\n\n` +
    `- **Content ID:** ${input.id}\n\n` +
    `This memory is soft-removed: recall and search will no longer return it. ` +
    `It is not permanently erased.`
  );
}

export async function handleGetContextPack(
  client: AnswerEngineClient,
  input: z.infer<typeof GetContextPackSchema>
): Promise<string> {
  const response = await client.query({
    query: input.query,
    libraryId: input.libraryId,
    librarySlug: input.librarySlug,
    conversationId: input.conversationId,
    sourceAgentId: input.sourceAgentId,
    searchType: input.searchType,
    include: ['summary'],
    limit: input.maxItems,
  });

  const { results, total } = response.data;
  const header = `${formatScope(response.data.scope)}## Context Pack — "${input.query}"\n\n`;

  if (results.length === 0) {
    return `${header}No relevant memories found.`;
  }

  const blocks: string[] = [];
  const includedIds: string[] = [];
  let usedChars = 0;
  let dropped = 0;

  for (const item of results) {
    let block = `### [${blocks.length + 1}] ${item.title}\n`;
    block += `- **ID:** ${item.id}\n`;
    block += `- **Type:** ${item.contentType}\n`;
    block += `- **Relevance:** ${item.relevanceScore.toFixed(3)}\n`;
    const body = item.summary ?? item.content ?? '';
    if (body) block += `\n${body}\n`;
    block += '\n';

    // Always include at least the first item so a valid query never returns an empty pack.
    if (blocks.length > 0 && usedChars + block.length > input.maxChars) {
      dropped += 1;
      continue;
    }
    blocks.push(block);
    includedIds.push(item.id);
    usedChars += block.length;
  }

  let output = header;
  output += `Included ${includedIds.length} of ${total} memories`;
  if (dropped > 0) output += ` (${dropped} dropped to fit the ${input.maxChars}-char budget)`;
  output += '.\n\n';
  output += blocks.join('');
  output += `---\nCitations: ${includedIds.join(', ')}`;
  return output;
}
