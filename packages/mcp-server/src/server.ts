/**
 * Shared Answer Engine MCP server factory.
 * Registers the same local-first tools and resources for stdio and HTTP transports.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import packageManifest from '../package.json' with { type: 'json' };
import { AnswerEngineClient, ApiError } from './api-client.js';
import {
  AskQuestionSchema,
  ForgetSchema,
  GetContentSchema,
  GetContextPackSchema,
  InspectMemorySchema,
  SaveContentSchema,
  SearchContentSchema,
  SummarizeCollectionSchema,
  handleAskQuestion,
  handleForget,
  handleGetContent,
  handleGetContextPack,
  handleInspectMemory,
  handleListTags,
  handleSaveContent,
  handleSearchContent,
  handleSummarizeCollection,
} from './tools.js';
import { staticResources, resourceTemplateConfigs, readResource } from './resources.js';

export const MCP_SERVER_VERSION = packageManifest.version;

const SEARCH_CAPABILITIES = [
  'fulltext_search',
  'semantic_search',
  'hybrid_search',
] as const;

const TOOL_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
  search_content: SEARCH_CAPABILITIES,
  recall: SEARCH_CAPABILITIES,
  get_context_pack: SEARCH_CAPABILITIES,
  get_content: ['retrieve'],
  summarize_collection: ['summarize'],
  ask: ['ask'],
  save_content: ['content_import'],
  append_memory: ['content_import'],
  remember: ['content_import'],
  forget: ['content_delete'],
  inspect_memory: ['content_lineage'],
};

export interface AnswerEngineMcpServerOptions {
  capabilities?: readonly string[];
}

export function formatMcpError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.statusCode === 401) return 'Authentication failed. Check your ANSWER_ENGINE_API_KEY.';
    if (error.statusCode === 429) return 'Rate limit exceeded. Please wait before making more requests.';
    return `API error (${error.code}): ${error.message}`;
  }
  if (error instanceof z.ZodError) {
    return `Invalid input: ${error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`;
  }
  return `Unexpected error: ${String(error)}`;
}

export async function resolveServerCapabilities(
  client: AnswerEngineClient,
): Promise<string[]> {
  try {
    const response = await client.getSchema();
    return Array.isArray(response.data.capabilities) ? response.data.capabilities : [];
  } catch (error) {
    process.stderr.write(`Failed to resolve MCP capabilities: ${String(error)}\n`);
    return [];
  }
}

export function createAnswerEngineMcpServer(
  client: AnswerEngineClient,
  options: AnswerEngineMcpServerOptions = {},
): McpServer {
  const capabilities = new Set(options.capabilities ?? []);
  const supports = (toolName: string): boolean =>
    TOOL_CAPABILITIES[toolName]?.some((capability) => capabilities.has(capability)) ?? true;

  const server = new McpServer({
    name: 'answer-engine',
    version: MCP_SERVER_VERSION,
  });

  if (supports('search_content')) {
    server.tool(
      'search_content',
      'Search local Answer Engine content using fulltext, semantic, or hybrid retrieval.',
      SearchContentSchema.shape,
      async (params) => toolResult(() => handleSearchContent(client, params)),
    );
  }

  if (supports('get_content')) {
    server.tool(
      'get_content',
      'Retrieve local content by ID or conversation, including summary, text, and metadata.',
      GetContentSchema.shape,
      async (params) => toolResult(() => handleGetContent(client, params)),
    );
  }

  // The schema endpoint itself provides this data, so it remains useful even
  // when no optional API capability is advertised or capability discovery fails.
  server.tool(
    'list_tags',
    'List content types, tags, retrieval capabilities, and the local content date range.',
    {},
    async () => toolResult(() => handleListTags(client)),
  );

  if (supports('summarize_collection')) {
    server.tool(
      'summarize_collection',
      'Summarize or analyze local Answer Engine content.',
      SummarizeCollectionSchema.shape,
      async (params) => toolResult(() => handleSummarizeCollection(client, params)),
    );
  }

  if (supports('ask')) {
    server.tool(
      'ask',
      'Ask a grounded question against local content and receive citations.',
      AskQuestionSchema.shape,
      async (params) => toolResult(() => handleAskQuestion(client, params)),
    );
  }

  if (supports('save_content')) {
    server.tool(
      'save_content',
      'Save one or more local memory/content items with optional idempotency identifiers.',
      SaveContentSchema.shape,
      async (params) => toolResult(() => handleSaveContent(client, params)),
    );
    server.tool(
      'append_memory',
      'Append a local memory. Alias of save_content.',
      SaveContentSchema.shape,
      async (params) => toolResult(() => handleSaveContent(client, params)),
    );
    server.tool(
      'remember',
      'Remember a fact or note locally. Reuse sourceIdentifier to update without duplication.',
      SaveContentSchema.shape,
      async (params) => toolResult(() => handleSaveContent(client, params)),
    );
  }

  if (supports('recall')) {
    server.tool(
      'recall',
      'Recall local memories ranked by relevance.',
      SearchContentSchema.shape,
      async (params) => toolResult(() => handleSearchContent(client, params)),
    );
    server.tool(
      'get_context_pack',
      'Gather relevant local memories into a compact, citation-bearing context pack.',
      GetContextPackSchema.shape,
      async (params) => toolResult(() => handleGetContextPack(client, params)),
    );
  }

  if (supports('forget')) {
    server.tool(
      'forget',
      'Soft-remove a local memory so recall and search no longer return it.',
      ForgetSchema.shape,
      async (params) => toolResult(() => handleForget(client, params)),
    );
  }

  if (supports('inspect_memory')) {
    server.tool(
      'inspect_memory',
      'Inspect a local memory source, current artifacts, and supersession lineage.',
      InspectMemorySchema.shape,
      async (params) => toolResult(() => handleInspectMemory(client, params)),
    );
  }

  for (const resource of staticResources) {
    server.resource(
      resource.name,
      resource.uri,
      { description: resource.description, mimeType: resource.mimeType },
      async (uri) => readResource(client, uri.href),
    );
  }

  for (const templateConfig of resourceTemplateConfigs) {
    const template = new ResourceTemplate(templateConfig.uriTemplate, { list: undefined });
    server.resource(
      templateConfig.name,
      template,
      { description: templateConfig.description, mimeType: templateConfig.mimeType },
      async (uri) => readResource(client, uri.href),
    );
  }

  return server;
}

async function toolResult(
  operation: () => Promise<string>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: true }> {
  try {
    return { content: [{ type: 'text', text: await operation() }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: formatMcpError(error) }],
      isError: true,
    };
  }
}
