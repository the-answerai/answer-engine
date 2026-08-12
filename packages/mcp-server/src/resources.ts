/**
 * MCP Resource Definitions
 * Expose Answer Engine data as MCP resources
 */

import { AnswerEngineClient, ApiError, type SchemaResponse } from './api-client.js';

export interface ResourceMetadata {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export const staticResources: ResourceMetadata[] = [
  {
    uri: 'answer-engine://schema',
    name: 'Content Schema',
    description:
      'Available content types, tags, and capabilities in your Answer Engine library',
    mimeType: 'application/json',
  },
  {
    uri: 'answer-engine://tags',
    name: 'Tag Taxonomy',
    description: 'Hierarchical tag taxonomy grouped by tag category',
    mimeType: 'application/json',
  },
  {
    uri: 'answer-engine://recent',
    name: 'Recent Content',
    description: 'Latest content items in your Answer Engine library',
    mimeType: 'application/json',
  },
];

export const resourceTemplateConfigs = [
  {
    uriTemplate: 'answer-engine://content/{id}',
    name: 'Content Item',
    description: 'Retrieve a specific content item by ID',
    mimeType: 'application/json',
  },
];

function buildTagTaxonomy(schema: SchemaResponse): {
  type: 'root';
  name: 'tags';
  totalTags: number;
  children: Array<{
    type: 'category';
    name: string;
    totalTags: number;
    children: Array<{
      type: 'tag';
      slug: string;
      label: string;
      description: string | null;
      category: string | null;
    }>;
  }>;
} {
  const categories = new Map<string, SchemaResponse['tags']>();

  for (const tag of schema.tags) {
    const category = tag.category ?? 'uncategorized';
    const existing = categories.get(category) ?? [];
    existing.push(tag);
    categories.set(category, existing);
  }

  const children = Array.from(categories.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, tags]) => ({
      type: 'category' as const,
      name: category,
      totalTags: tags.length,
      children: [...tags]
        .sort((left, right) => left.label.localeCompare(right.label))
        .map((tag) => ({
          type: 'tag' as const,
          slug: tag.slug,
          label: tag.label,
          description: tag.description,
          category: tag.category,
        })),
    }));

  return {
    type: 'root',
    name: 'tags',
    totalTags: schema.tags.length,
    children,
  };
}

export async function readResource(
  client: AnswerEngineClient,
  uri: string
): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
  try {
    if (uri === 'answer-engine://schema') {
      const response = await client.getSchema();
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    }

    if (uri === 'answer-engine://tags') {
      const response = await client.getSchema();
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(buildTagTaxonomy(response.data), null, 2),
          },
        ],
      };
    }

    if (uri === 'answer-engine://recent') {
      const response = await client.getRecentContent(10);
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                count: response.data.length,
                items: response.data,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    const contentMatch = /^answer-engine:\/\/content\/(.+)$/.exec(uri);
    if (contentMatch) {
      const id = contentMatch[1];
      const response = await client.retrieve({
        ids: [id],
        include: ['summary', 'content', 'metadata'],
      });
      const item = response.data.items[0];
      if (!item) {
        throw new Error(`Content item not found: ${id}`);
      }
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(item, null, 2),
          },
        ],
      };
    }

    throw new Error(`Unknown resource URI: ${uri}`);
  } catch (error) {
    if (error instanceof ApiError) {
      throw new Error(`API error (${error.code}): ${error.message}`);
    }
    throw error;
  }
}
