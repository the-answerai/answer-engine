import { z } from 'zod';
import { LibraryFilterSchema } from '../library/library-membership.js';

const SlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120);
const EvidenceSchema = z.object({
  contentId: z.string().uuid(),
  title: z.string().min(1).max(500),
  source: z.string().min(1).max(120),
}).strict();

const SuggestionBaseSchema = z.object({
  id: z.string().regex(/^s-[a-f0-9]{16}$/),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(1_000),
  evidence: z.array(EvidenceSchema).min(1).max(3),
  dependsOn: z.array(z.string().regex(/^s-[a-f0-9]{16}$/)).max(4).default([]),
});

export const OrganizationSuggestionSchema = z.discriminatedUnion('type', [
  SuggestionBaseSchema.extend({
    type: z.literal('tag.create'),
    tag: z.object({
      slug: SlugSchema,
      label: z.string().trim().min(1).max(120),
      description: z.string().trim().max(1_000).nullable(),
      category: z.string().trim().max(120).nullable(),
      color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable(),
    }).strict(),
  }).strict(),
  SuggestionBaseSchema.extend({
    type: z.literal('tag.assign'),
    tagSlug: SlugSchema,
    contentIds: z.array(z.string().uuid()).min(1).max(100),
  }).strict(),
  SuggestionBaseSchema.extend({
    type: z.literal('library.create'),
    library: z.object({
      slug: SlugSchema,
      name: z.string().trim().min(1).max(160),
      description: z.string().trim().max(1_000).nullable(),
      filter: LibraryFilterSchema.nullable(),
    }).strict(),
  }).strict(),
]);

export const OrganizationSuggestionsSchema = z.array(OrganizationSuggestionSchema).max(30)
  .superRefine((suggestions, context) => {
    const ids = new Set<string>();
    for (const suggestion of suggestions) {
      if (ids.has(suggestion.id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate suggestion ${suggestion.id}` });
      }
      ids.add(suggestion.id);
    }
    for (const suggestion of suggestions) {
      for (const dependency of suggestion.dependsOn) {
        if (!ids.has(dependency) || dependency === suggestion.id) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid dependency ${dependency}` });
        }
      }
    }
  });

export const OrganizationProposalRequestSchema = z.object({
  useModel: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(50),
}).strict();

export const OrganizationDecisionSchema = z.object({
  suggestionId: z.string().regex(/^s-[a-f0-9]{16}$/),
  decision: z.enum(['accept', 'reject']),
}).strict();

export const OrganizationApplyRequestSchema = z.object({
  decisions: z.array(OrganizationDecisionSchema).max(30),
}).strict();

export const OrganizationModelCategorySchema = z.object({
  slug: SlugSchema,
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).nullable().default(null),
  contentIds: z.array(z.string().uuid()).min(1).max(100),
  confidence: z.number().min(0).max(1),
  rationale: z.string().trim().min(1).max(1_000),
  createLibrary: z.boolean().default(false),
  libraryName: z.string().trim().min(1).max(160).optional(),
}).strict();

export const OrganizationModelResponseSchema = z.object({
  categories: z.array(OrganizationModelCategorySchema).max(10),
}).strict();

export type OrganizationSuggestion = z.infer<typeof OrganizationSuggestionSchema>;
export type OrganizationDecision = z.infer<typeof OrganizationDecisionSchema>;
