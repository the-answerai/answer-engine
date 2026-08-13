import { z } from 'zod';
import { LibraryFilterSchema } from '../library/library-membership.js';

export const UuidSchema = z.string().uuid();
export const SlugSchema = z.string().trim().min(1).max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const PageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
}).strict();

export const TagCreateSchema = z.object({
  slug: SlugSchema,
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).nullable().optional(),
  category: z.string().trim().max(120).nullable().optional(),
  parentId: UuidSchema.nullable().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
}).strict();
export const TagUpdateSchema = TagCreateSchema.partial().strict();
export const TagAssignmentSchema = z.object({
  contentIds: z.array(UuidSchema).min(1).max(500),
}).strict();

export const LibraryCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: SlugSchema,
  description: z.string().trim().max(2_000).nullable().optional(),
  filter: LibraryFilterSchema.nullable().default(null),
  metadata: z.record(z.unknown()).default({}),
}).strict();
export const LibraryUpdateSchema = LibraryCreateSchema.partial().strict();
export const LibraryMembersSchema = PageSchema.extend({
  query: z.string().trim().max(500).optional(),
}).strict();
export const LibraryPreviewSchema = z.object({
  filter: LibraryFilterSchema.nullable().default(null),
  limit: z.number().int().min(1).max(100).default(25),
}).strict();

const ContentTypeSchema = z.enum(['call', 'document', 'ticket', 'domain', 'chat', 'page']);
export const RecipeCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).nullable().optional(),
  contentTypes: z.array(ContentTypeSchema).min(1).max(6),
  systemPrompt: z.string().trim().min(1).max(20_000),
  userPromptTemplate: z.string().trim().min(1).max(20_000),
  outputType: z.string().trim().min(1).max(120)
    .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/),
  outputSchema: z.record(z.unknown()).nullable().optional(),
  modelId: z.string().trim().max(200).nullable().optional(),
  maxTokens: z.number().int().min(1).max(32_000).nullable().optional(),
  isActive: z.boolean().default(true),
}).strict();
export const RecipeUpdateSchema = RecipeCreateSchema.partial().strict();
export const RecipePreviewSchema = z.object({
  contentIds: z.array(UuidSchema).max(10).optional(),
  limit: z.number().int().min(1).max(10).default(3),
}).strict();

export const ReportCreateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  slug: SlugSchema,
  description: z.string().trim().max(2_000).nullable().optional(),
  prompt: z.string().trim().min(1).max(20_000),
  schedule: z.string().trim().max(200).nullable().optional(),
  isActive: z.boolean().default(true),
}).strict();
export const ReportUpdateSchema = ReportCreateSchema.partial().strict();

export const DashboardCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).nullable().optional(),
  layout: z.array(z.record(z.unknown())).default([]),
  widgets: z.array(z.record(z.unknown())).default([]),
}).strict();
export const DashboardUpdateSchema = DashboardCreateSchema.partial().strict();

export const BatchJobCreateSchema = z.object({
  libraryId: UuidSchema.nullable().optional(),
  kind: z.enum(['prompt', 'export', 'import']),
  name: z.string().trim().min(1).max(200),
  input: z.record(z.unknown()).default({}),
  contentIds: z.array(UuidSchema).max(10_000).optional(),
}).strict();

export const AccessTokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1_000).nullable().optional(),
  libraryId: UuidSchema.nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  capabilities: z.array(z.enum(['read', 'write'])).min(1).default(['read', 'write']),
}).strict();
export const AccessTokenUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1_000).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
}).strict();

export const AuditQuerySchema = PageSchema.extend({
  libraryId: UuidSchema.optional(),
  action: z.string().trim().max(120).optional(),
  resourceType: z.string().trim().max(120).optional(),
}).strict();

export const BlobUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mediaType: z.string().trim().min(1).max(255),
  dataBase64: z.string().min(1).max(30 * 1024 * 1024).base64(),
  sourceMetadata: z.record(z.unknown()).default({}),
}).strict();

export function recipeResponseFormat(outputSchema: Record<string, unknown> | null | undefined) {
  if (!outputSchema) return undefined;
  return {
    type: 'json_schema',
    json_schema: {
      name: 'recipe_output',
      strict: true,
      schema: outputSchema,
    },
  };
}

export function parseRecipeOutput(
  text: string,
  outputSchema: Record<string, unknown> | null | undefined,
): unknown {
  if (!outputSchema) return undefined;
  const withoutFences = text.replace(/```(?:json)?/gi, '').trim();
  return JSON.parse(withoutFences) as unknown;
}
