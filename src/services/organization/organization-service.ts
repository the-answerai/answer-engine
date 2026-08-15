import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../../config/database.js';
import type { Principal } from '../../types/api.js';
import { ConflictError, NotFoundError } from '../../utils/errors.js';
import type { LanguageProvider } from '../ai/openai-compatible.js';
import {
  OrganizationApplyRequestSchema,
  OrganizationModelResponseSchema,
  OrganizationProposalRequestSchema,
  OrganizationSuggestionsSchema,
  type OrganizationDecision,
  type OrganizationSuggestion,
} from './organization-schemas.js';

type Queryable = Pick<Database, 'query'>;

interface ContentSample {
  id: string;
  title: string;
  summary: string;
  source: string;
  contentType: string;
  updatedAt: Date;
  tagSlugs: string[];
}

interface TaxonomyItem {
  id: string;
  slug: string;
  label: string;
  updatedAt: Date;
}

interface OrganizationContext {
  content: ContentSample[];
  tags: TaxonomyItem[];
  libraries: TaxonomyItem[];
  fingerprint: string;
}

interface PlanRecord {
  id: string;
  status: 'preview' | 'applied' | 'undone';
  proposal_mode: 'local' | 'model';
  sample_limit: number;
  sample_count: number;
  source_snapshot_sha256: string;
  proposal_sha256: string;
  suggestions: unknown;
  decisions: unknown;
  apply_result: unknown;
  model_provider: string | null;
  model_id: string | null;
  applied_at: Date | null;
  undone_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const ApplyResultSchema = z.array(z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tag.create'), suggestionId: z.string(), resourceId: z.string().uuid(),
    created: z.boolean(), reactivated: z.boolean(), updatedAt: z.string().datetime().nullable(),
  }).strict(),
  z.object({
    type: z.literal('tag.assign'), suggestionId: z.string(), resourceId: z.string().uuid(),
    addedContentIds: z.array(z.string().uuid()),
  }).strict(),
  z.object({
    type: z.literal('library.create'), suggestionId: z.string(), resourceId: z.string().uuid(),
    created: z.boolean(), reactivated: z.boolean(), updatedAt: z.string().datetime().nullable(),
  }).strict(),
]));
type ApplyResult = z.infer<typeof ApplyResultSchema>;

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 110) || 'memory';
}

function suggestionId(value: unknown): string {
  return `s-${sha256(value).slice(0, 16)}`;
}

function evidence(rows: readonly ContentSample[]) {
  return rows.slice(0, 3).map((row) => ({ contentId: row.id, title: row.title, source: row.source }));
}

function publicPlan(row: PlanRecord) {
  return {
    id: row.id,
    status: row.status,
    proposalMode: row.proposal_mode,
    sampleLimit: row.sample_limit,
    sampleCount: row.sample_count,
    sourceSnapshotSha256: row.source_snapshot_sha256,
    proposalSha256: row.proposal_sha256,
    suggestions: OrganizationSuggestionsSchema.parse(row.suggestions),
    decisions: row.decisions == null ? null : OrganizationApplyRequestSchema.shape.decisions.parse(row.decisions),
    applyResult: row.apply_result == null ? null : ApplyResultSchema.parse(row.apply_result),
    modelProvider: row.model_provider,
    modelId: row.model_id,
    appliedAt: row.applied_at,
    undoneAt: row.undone_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class OrganizationService {
  constructor(
    private readonly database: Database,
    private readonly language: LanguageProvider,
  ) {}

  private assertTenantAccess(principal: Principal): void {
    if (principal.libraryId) throw new NotFoundError('Organization plan not found');
  }

  private async audit(
    database: Queryable,
    principal: Principal,
    action: string,
    planId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await database.query(
      `INSERT INTO audit_log (
         tenant_id, library_id, api_key_id, action, resource_type, resource_id, details
       ) VALUES ($1,NULL,$2,$3,'organization_plan',$4,$5)`,
      [principal.tenantId, principal.apiKeyId, action, planId, details],
    );
  }

  private async context(database: Queryable, tenantId: string, limit: number): Promise<OrganizationContext> {
    const content = await database.query<ContentSample>(
      `SELECT c.id, c.title, LEFT(COALESCE(c.summary, ''), 500) AS summary,
              c.source, c.content_type AS "contentType", c.updated_at AS "updatedAt",
              COALESCE(ARRAY_AGG(t.slug ORDER BY t.slug)
                FILTER (WHERE t.slug IS NOT NULL), '{}'::text[]) AS "tagSlugs"
         FROM content_items c
         LEFT JOIN content_tags ct ON ct.tenant_id=c.tenant_id AND ct.content_id=c.id
         LEFT JOIN tags t ON t.tenant_id=ct.tenant_id AND t.id=ct.tag_id AND t.is_active=true
        WHERE c.tenant_id=$1 AND c.status <> 'deleted'
        GROUP BY c.id
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT $2`,
      [tenantId, limit],
    );
    const tags = await database.query<TaxonomyItem>(
      `SELECT id, slug, label, updated_at AS "updatedAt" FROM tags
        WHERE tenant_id=$1 AND is_active=true ORDER BY slug,id`,
      [tenantId],
    );
    const libraries = await database.query<TaxonomyItem>(
      `SELECT id, slug, name AS label, updated_at AS "updatedAt" FROM libraries
        WHERE tenant_id=$1 AND is_active=true ORDER BY slug,id`,
      [tenantId],
    );
    const normalized = {
      content: content.rows.map((row) => ({
        ...row,
        updatedAt: row.updatedAt.toISOString(),
        tagSlugs: [...row.tagSlugs].sort(),
      })),
      tags: tags.rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })),
      libraries: libraries.rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })),
    };
    return { content: content.rows, tags: tags.rows, libraries: libraries.rows, fingerprint: sha256(normalized) };
  }

  private suggestionsForCategories(
    context: OrganizationContext,
    categories: Array<{
      slug: string;
      label: string;
      description: string | null;
      contentIds: string[];
      confidence: number;
      rationale: string;
      createLibrary: boolean;
      libraryName?: string;
      libraryFilter?: { operator: 'and'; conditions: Array<{ field: 'source' | 'tag'; operator: 'eq'; value: string }> };
    }>,
  ): OrganizationSuggestion[] {
    const rowsById = new Map(context.content.map((row) => [row.id, row]));
    const existingTags = new Set(context.tags.map((tag) => tag.slug));
    const existingLibraries = new Set(context.libraries.map((library) => library.slug));
    const seenCategories = new Set<string>();
    const suggestions: OrganizationSuggestion[] = [];
    for (const category of categories) {
      if (seenCategories.has(category.slug)) continue;
      seenCategories.add(category.slug);
      const rows = [...new Set(category.contentIds)].map((id) => rowsById.get(id)).filter((row): row is ContentSample => Boolean(row));
      if (rows.length === 0) continue;
      let createTagId: string | undefined;
      if (!existingTags.has(category.slug)) {
        const action = { type: 'tag.create', slug: category.slug, label: category.label };
        createTagId = suggestionId(action);
        suggestions.push({
          id: createTagId,
          type: 'tag.create',
          tag: {
            slug: category.slug,
            label: category.label,
            description: category.description,
            category: 'Suggested',
            color: '#1B3A8F',
          },
          confidence: category.confidence,
          rationale: category.rationale,
          evidence: evidence(rows),
          dependsOn: [],
        });
      }
      const missing = rows.filter((row) => !row.tagSlugs.includes(category.slug));
      if (missing.length > 0) {
        const action = { type: 'tag.assign', slug: category.slug, contentIds: missing.map((row) => row.id).sort() };
        suggestions.push({
          id: suggestionId(action),
          type: 'tag.assign',
          tagSlug: category.slug,
          contentIds: missing.map((row) => row.id),
          confidence: category.confidence,
          rationale: `Assign ${category.label} only to the supported records shown in this proposal.`,
          evidence: evidence(missing),
          dependsOn: createTagId ? [createTagId] : [],
        });
      }
      const librarySlug = `${category.slug}-memory`.slice(0, 120);
      if (category.createLibrary && !existingLibraries.has(librarySlug)) {
        const filter = category.libraryFilter ?? {
          operator: 'and' as const,
          conditions: [{ field: 'tag' as const, operator: 'eq' as const, value: category.slug }],
        };
        const action = { type: 'library.create', slug: librarySlug, filter };
        suggestions.push({
          id: suggestionId(action),
          type: 'library.create',
          library: {
            slug: librarySlug,
            name: category.libraryName ?? `${category.label} memory`,
            description: `Suggested from ${rows.length} supported source records.`,
            filter,
          },
          confidence: category.confidence,
          rationale: `Create a reusable filtered library for this grouping.`,
          evidence: evidence(rows),
          dependsOn: filter.conditions.some((condition) => condition.field === 'tag') && createTagId
            ? [createTagId]
            : [],
        });
      }
    }
    return OrganizationSuggestionsSchema.parse(suggestions);
  }

  private localSuggestions(context: OrganizationContext): OrganizationSuggestion[] {
    const groups = new Map<string, ContentSample[]>();
    for (const item of context.content) groups.set(item.source, [...(groups.get(item.source) ?? []), item]);
    const categories = [...groups.entries()]
      .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
      .slice(0, 8)
      .map(([source, rows]) => ({
        slug: slugify(source),
        label: source.split(/[-_]/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' '),
        description: `Content imported from ${source}.`,
        contentIds: rows.map((row) => row.id),
        confidence: 1,
        rationale: `All ${rows.length} examples share the explicit source identifier “${source}”.`,
        createLibrary: rows.length >= 2,
        libraryFilter: {
          operator: 'and' as const,
          conditions: [{ field: 'source' as const, operator: 'eq' as const, value: source }],
        },
      }));
    return this.suggestionsForCategories(context, categories);
  }

  private async modelSuggestions(context: OrganizationContext): Promise<{
    suggestions: OrganizationSuggestion[]; provider: string; model: string;
  }> {
    const completion = await this.language.complete({
      system: 'Propose a small, explainable taxonomy for local personal memory. Return strict JSON only. Never invent content IDs.',
      prompt: JSON.stringify({
        task: 'Group related records. Every category must cite only contentIds supplied below.',
        existingTagSlugs: context.tags.map((tag) => tag.slug),
        existingLibrarySlugs: context.libraries.map((library) => library.slug),
        records: context.content.map((row) => ({
          id: row.id, title: row.title, summary: row.summary, source: row.source,
          contentType: row.contentType, existingTags: row.tagSlugs,
        })),
        responseShape: {
          categories: [{
            slug: 'lowercase-hyphenated', label: 'Label', description: null,
            contentIds: ['uuid'], confidence: 0.8, rationale: 'Why these examples support it',
            createLibrary: false, libraryName: 'Optional name',
          }],
        },
      }),
      maxTokens: 2_048,
      responseFormat: { type: 'json_object' },
    });
    const parsed = OrganizationModelResponseSchema.parse(JSON.parse(completion.text));
    const allowedIds = new Set(context.content.map((row) => row.id));
    for (const category of parsed.categories) {
      if (category.contentIds.some((id) => !allowedIds.has(id))) {
        throw new Error('Organization model referenced content outside the bounded proposal sample');
      }
    }
    return {
      suggestions: this.suggestionsForCategories(context, parsed.categories),
      provider: completion.provider,
      model: completion.model,
    };
  }

  async createProposal(principal: Principal, raw: unknown) {
    this.assertTenantAccess(principal);
    const input = OrganizationProposalRequestSchema.parse(raw);
    const context = await this.context(this.database, principal.tenantId, input.limit);
    const generated = input.useModel
      ? await this.modelSuggestions(context)
      : { suggestions: this.localSuggestions(context), provider: null, model: null };
    const proposalSha256 = sha256(generated.suggestions);
    const inserted = await this.database.query<PlanRecord>(
      `INSERT INTO organization_plans (
         tenant_id, proposal_mode, sample_limit, sample_count, source_snapshot_sha256,
         proposal_sha256, suggestions, model_provider, model_id, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id,source_snapshot_sha256,proposal_sha256) DO NOTHING
       RETURNING *`,
      [principal.tenantId, input.useModel ? 'model' : 'local', input.limit, context.content.length,
        context.fingerprint, proposalSha256, generated.suggestions, generated.provider,
        generated.model, principal.apiKeyId],
    );
    const row = inserted.rows[0] ?? (await this.database.query<PlanRecord>(
      `SELECT * FROM organization_plans
        WHERE tenant_id=$1 AND source_snapshot_sha256=$2 AND proposal_sha256=$3`,
      [principal.tenantId, context.fingerprint, proposalSha256],
    )).rows[0];
    if (!row) throw new Error('Organization proposal could not be persisted');
    if (inserted.rows[0]) {
      await this.audit(this.database, principal, 'organization.preview', row.id, {
        proposalMode: row.proposal_mode,
        sampleCount: row.sample_count,
        suggestionCount: generated.suggestions.length,
        exposedFields: ['id', 'title', 'summary:500', 'source', 'contentType', 'existingTags'],
      });
    }
    return publicPlan(row);
  }

  async listPlans(principal: Principal) {
    this.assertTenantAccess(principal);
    const result = await this.database.query<PlanRecord>(
      `SELECT * FROM organization_plans WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 25`,
      [principal.tenantId],
    );
    return result.rows.map(publicPlan);
  }

  async getPlan(principal: Principal, planId: string) {
    this.assertTenantAccess(principal);
    const result = await this.database.query<PlanRecord>(
      `SELECT * FROM organization_plans WHERE tenant_id=$1 AND id=$2`,
      [principal.tenantId, planId],
    );
    if (!result.rows[0]) throw new NotFoundError('Organization plan not found');
    return publicPlan(result.rows[0]);
  }

  private validateDecisions(suggestions: OrganizationSuggestion[], decisions: OrganizationDecision[]): Set<string> {
    const bySuggestion = new Map<string, OrganizationDecision>();
    for (const decision of decisions) {
      if (bySuggestion.has(decision.suggestionId)) throw new ConflictError('Each suggestion requires exactly one decision');
      bySuggestion.set(decision.suggestionId, decision);
    }
    if (bySuggestion.size !== suggestions.length
      || suggestions.some((suggestion) => !bySuggestion.has(suggestion.id))) {
      throw new ConflictError('Accept or reject every organization suggestion before applying');
    }
    const accepted = new Set(decisions.filter((decision) => decision.decision === 'accept')
      .map((decision) => decision.suggestionId));
    for (const suggestion of suggestions) {
      if (accepted.has(suggestion.id) && suggestion.dependsOn.some((id) => !accepted.has(id))) {
        throw new ConflictError(`Accepted suggestion ${suggestion.id} requires its accepted dependencies`);
      }
    }
    return accepted;
  }

  async applyPlan(principal: Principal, planId: string, raw: unknown) {
    this.assertTenantAccess(principal);
    const input = OrganizationApplyRequestSchema.parse(raw);
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<PlanRecord>(
        `SELECT * FROM organization_plans WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [principal.tenantId, planId],
      );
      const plan = locked.rows[0];
      if (!plan) throw new NotFoundError('Organization plan not found');
      if (plan.status !== 'preview' && plan.status !== 'undone') {
        throw new ConflictError('Only a preview or undone organization plan can be applied');
      }
      const suggestions = OrganizationSuggestionsSchema.parse(plan.suggestions);
      const accepted = this.validateDecisions(suggestions, input.decisions);
      const current = await this.context(client, principal.tenantId, plan.sample_limit);
      if (current.fingerprint !== plan.source_snapshot_sha256) {
        throw new ConflictError('Organization proposal is stale; generate and review a fresh proposal');
      }
      const results: ApplyResult = [];
      for (const suggestion of suggestions) {
        if (!accepted.has(suggestion.id)) continue;
        if (suggestion.type === 'tag.create') {
          const existing = await client.query<{ id: string; is_active: boolean; metadata: Record<string, unknown> }>(
            `SELECT id,is_active,metadata FROM tags WHERE tenant_id=$1 AND slug=$2`,
            [principal.tenantId, suggestion.tag.slug],
          );
          if (existing.rows[0] && !existing.rows[0].is_active) {
            if (existing.rows[0].metadata?.organizationPlanId !== planId) {
              throw new ConflictError(`Inactive tag slug ${suggestion.tag.slug} requires manual review`);
            }
            const reactivated = await client.query<{ updated_at: Date }>(
              `UPDATE tags SET is_active=true,label=$3,description=$4,category=$5,color=$6,metadata=$7
                WHERE tenant_id=$1 AND id=$2 RETURNING updated_at`,
              [principal.tenantId, existing.rows[0].id, suggestion.tag.label,
                suggestion.tag.description, suggestion.tag.category, suggestion.tag.color,
                { organizationPlanId: planId, confidence: suggestion.confidence }],
            );
            results.push({
              type: 'tag.create', suggestionId: suggestion.id, resourceId: existing.rows[0].id,
              created: false, reactivated: true, updatedAt: reactivated.rows[0]!.updated_at.toISOString(),
            });
            continue;
          }
          if (existing.rows[0]) {
            results.push({ type: 'tag.create', suggestionId: suggestion.id, resourceId: existing.rows[0].id, created: false, reactivated: false, updatedAt: null });
          } else {
            const created = await client.query<{ id: string; updated_at: Date }>(
              `INSERT INTO tags (tenant_id,slug,label,description,category,color,metadata)
               VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,updated_at`,
              [principal.tenantId, suggestion.tag.slug, suggestion.tag.label,
                suggestion.tag.description, suggestion.tag.category, suggestion.tag.color,
                { organizationPlanId: planId, confidence: suggestion.confidence }],
            );
            const row = created.rows[0]!;
            results.push({ type: 'tag.create', suggestionId: suggestion.id, resourceId: row.id, created: true, reactivated: false, updatedAt: row.updated_at.toISOString() });
          }
        } else if (suggestion.type === 'tag.assign') {
          const tag = await client.query<{ id: string }>(
            `SELECT id FROM tags WHERE tenant_id=$1 AND slug=$2 AND is_active=true`,
            [principal.tenantId, suggestion.tagSlug],
          );
          if (!tag.rows[0]) throw new ConflictError(`Accepted tag ${suggestion.tagSlug} does not exist`);
          const inserted = await client.query<{ content_id: string }>(
            `INSERT INTO content_tags (tenant_id,content_id,tag_id,confidence,applied_by,metadata)
             SELECT $1,c.id,$2,$3,$4,$5 FROM content_items c
              WHERE c.tenant_id=$1 AND c.id=ANY($6::uuid[]) AND c.status <> 'deleted'
             ON CONFLICT DO NOTHING RETURNING content_id`,
            [principal.tenantId, tag.rows[0].id, suggestion.confidence, principal.apiKeyId,
              { organizationPlanId: planId, suggestionId: suggestion.id }, suggestion.contentIds],
          );
          results.push({
            type: 'tag.assign', suggestionId: suggestion.id, resourceId: tag.rows[0].id,
            addedContentIds: inserted.rows.map((row) => row.content_id),
          });
        } else {
          const existing = await client.query<{ id: string; is_active: boolean; metadata: Record<string, unknown> }>(
            `SELECT id,is_active,metadata FROM libraries WHERE tenant_id=$1 AND slug=$2`,
            [principal.tenantId, suggestion.library.slug],
          );
          if (existing.rows[0] && !existing.rows[0].is_active) {
            if (existing.rows[0].metadata?.organizationPlanId !== planId) {
              throw new ConflictError(`Inactive library slug ${suggestion.library.slug} requires manual review`);
            }
            const reactivated = await client.query<{ updated_at: Date }>(
              `UPDATE libraries SET is_active=true,name=$3,description=$4,filter_predicate=$5,metadata=$6
                WHERE tenant_id=$1 AND id=$2 RETURNING updated_at`,
              [principal.tenantId, existing.rows[0].id, suggestion.library.name,
                suggestion.library.description, suggestion.library.filter,
                { organizationPlanId: planId, confidence: suggestion.confidence }],
            );
            results.push({
              type: 'library.create', suggestionId: suggestion.id, resourceId: existing.rows[0].id,
              created: false, reactivated: true, updatedAt: reactivated.rows[0]!.updated_at.toISOString(),
            });
            continue;
          }
          if (existing.rows[0]) {
            results.push({ type: 'library.create', suggestionId: suggestion.id, resourceId: existing.rows[0].id, created: false, reactivated: false, updatedAt: null });
          } else {
            const created = await client.query<{ id: string; updated_at: Date }>(
              `INSERT INTO libraries (tenant_id,name,slug,description,filter_predicate,metadata,created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,updated_at`,
              [principal.tenantId, suggestion.library.name, suggestion.library.slug,
                suggestion.library.description, suggestion.library.filter,
                { organizationPlanId: planId, confidence: suggestion.confidence }, principal.apiKeyId],
            );
            const row = created.rows[0]!;
            results.push({ type: 'library.create', suggestionId: suggestion.id, resourceId: row.id, created: true, reactivated: false, updatedAt: row.updated_at.toISOString() });
          }
        }
      }
      const updated = await client.query<PlanRecord>(
        `UPDATE organization_plans SET status='applied', decisions=$3, apply_result=$4,
                applied_by=$5, applied_at=NOW(), undone_by=NULL, undone_at=NULL
          WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [principal.tenantId, planId, input.decisions, results, principal.apiKeyId],
      );
      await this.audit(client, principal, 'organization.apply', planId, {
        accepted: accepted.size,
        rejected: suggestions.length - accepted.size,
        results,
      });
      await client.query('COMMIT');
      return publicPlan(updated.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async undoPlan(principal: Principal, planId: string) {
    this.assertTenantAccess(principal);
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<PlanRecord>(
        `SELECT * FROM organization_plans WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [principal.tenantId, planId],
      );
      const plan = locked.rows[0];
      if (!plan) throw new NotFoundError('Organization plan not found');
      if (plan.status !== 'applied') throw new ConflictError('Only an applied organization plan can be undone');
      const results = ApplyResultSchema.parse(plan.apply_result);
      for (const result of [...results].reverse()) {
        if (result.type === 'tag.assign' && result.addedContentIds.length > 0) {
          await client.query(
            `DELETE FROM content_tags WHERE tenant_id=$1 AND tag_id=$2 AND content_id=ANY($3::uuid[])
              AND metadata->>'organizationPlanId'=$4`,
            [principal.tenantId, result.resourceId, result.addedContentIds, planId],
          );
        } else if (result.type === 'tag.create' && (result.created || result.reactivated)) {
          const changed = await client.query(
            `UPDATE tags SET is_active=false WHERE tenant_id=$1 AND id=$2 AND updated_at=$3::timestamptz`,
            [principal.tenantId, result.resourceId, result.updatedAt],
          );
          if (!changed.rowCount) throw new ConflictError('A created tag changed after apply and cannot be safely undone');
        } else if (result.type === 'library.create' && (result.created || result.reactivated)) {
          const changed = await client.query(
            `UPDATE libraries SET is_active=false WHERE tenant_id=$1 AND id=$2 AND updated_at=$3::timestamptz`,
            [principal.tenantId, result.resourceId, result.updatedAt],
          );
          if (!changed.rowCount) throw new ConflictError('A created library changed after apply and cannot be safely undone');
        }
      }
      const updated = await client.query<PlanRecord>(
        `UPDATE organization_plans SET status='undone', undone_by=$3, undone_at=NOW()
          WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [principal.tenantId, planId, principal.apiKeyId],
      );
      await this.audit(client, principal, 'organization.undo', planId, { reverted: results.length });
      await client.query('COMMIT');
      return publicPlan(updated.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
