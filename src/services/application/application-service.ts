import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../../config/database.js';
import type { Principal } from '../../types/api.js';
import { hashApiKey } from '../../middleware/api-key-auth.js';
import { ConflictError, NotFoundError } from '../../utils/errors.js';
import type { LanguageProvider } from '../ai/openai-compatible.js';
import { logger } from '../../utils/logger.js';
import {
  AccessTokenCreateSchema,
  AccessTokenUpdateSchema,
  AuditQuerySchema,
  BatchJobCreateSchema,
  BlobUploadSchema,
  DashboardCreateSchema,
  DashboardUpdateSchema,
  LibraryCreateSchema,
  LibraryMembersSchema,
  LibraryPreviewSchema,
  LibraryUpdateSchema,
  LocalSettingsUpdateSchema,
  PageSchema,
  RecipeCreateSchema,
  RecipePreviewSchema,
  RecipeUpdateSchema,
  ReportCreateSchema,
  ReportUpdateSchema,
  TagAssignmentSchema,
  TagCreateSchema,
  TagUpdateSchema,
  parseRecipeOutput,
  recipeResponseFormat,
} from './application-schemas.js';
import {
  LibraryFilterSchema,
  buildEffectiveMembership,
  type LibraryFilter,
} from '../library/library-membership.js';
import { LocalBlobStorage } from '../storage/local-blob-storage.js';

type TagCreate = z.infer<typeof TagCreateSchema>;
type TagUpdate = z.infer<typeof TagUpdateSchema>;
type LibraryCreate = z.infer<typeof LibraryCreateSchema>;
type LibraryUpdate = z.infer<typeof LibraryUpdateSchema>;
type RecipeCreate = z.infer<typeof RecipeCreateSchema>;
type RecipeUpdate = z.infer<typeof RecipeUpdateSchema>;
type ReportCreate = z.infer<typeof ReportCreateSchema>;
type ReportUpdate = z.infer<typeof ReportUpdateSchema>;
type DashboardCreate = z.infer<typeof DashboardCreateSchema>;
type DashboardUpdate = z.infer<typeof DashboardUpdateSchema>;
type LocalSettingsUpdate = z.infer<typeof LocalSettingsUpdateSchema>;

const DEFAULT_LOCAL_SETTINGS = {
  defaultPageSize: 25,
  defaultLibraryId: null,
  density: 'comfortable' as const,
  defaultExportFormat: 'json' as const,
};

function publicLocalSettings(raw: unknown) {
  const settings = z.record(z.unknown()).catch({}).parse(raw);
  return {
    defaultPageSize: z.number().int().min(10).max(100).catch(DEFAULT_LOCAL_SETTINGS.defaultPageSize)
      .parse(settings.defaultPageSize),
    defaultLibraryId: z.string().uuid().nullable().catch(DEFAULT_LOCAL_SETTINGS.defaultLibraryId)
      .parse(settings.defaultLibraryId),
    density: z.enum(['comfortable', 'compact']).catch(DEFAULT_LOCAL_SETTINGS.density)
      .parse(settings.density),
    defaultExportFormat: z.enum(['json', 'csv', 'markdown']).catch(DEFAULT_LOCAL_SETTINGS.defaultExportFormat)
      .parse(settings.defaultExportFormat),
  };
}

interface LibraryRecord {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  kind: 'system_all_content' | 'user_defined';
  filter_predicate: unknown;
  metadata: Record<string, unknown>;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function encodeCursor(date: Date, id: string): string {
  return Buffer.from(JSON.stringify([date.toISOString(), id])).toString('base64url');
}

function decodeCursor(cursor: string): [string, string] {
  const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  return z.tuple([z.string().datetime(), z.string().uuid()]).parse(value);
}

function promptHash(input: RecipeCreate): string {
  return createHash('sha256').update(JSON.stringify({
    contentTypes: input.contentTypes,
    systemPrompt: input.systemPrompt,
    userPromptTemplate: input.userPromptTemplate,
    outputType: input.outputType,
    outputSchema: input.outputSchema ?? null,
    modelId: input.modelId ?? null,
    maxTokens: input.maxTokens ?? null,
  })).digest('hex');
}

function publicLibrary(row: LibraryRecord, itemCount: number) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    kind: row.kind,
    filter: row.filter_predicate,
    metadata: row.metadata,
    isActive: row.is_active,
    itemCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ApplicationService {
  constructor(
    private readonly database: Database,
    private readonly language: LanguageProvider,
    private readonly storage: LocalBlobStorage,
  ) {}

  private assertLibraryAccess(principal: Principal, libraryId: string): void {
    if (principal.libraryId && principal.libraryId !== libraryId) {
      throw new NotFoundError('Library not found');
    }
  }

  private assertTenantAccess(principal: Principal): void {
    if (principal.libraryId) throw new NotFoundError('Resource not found');
  }

  private async audit(
    principal: Principal,
    action: string,
    resourceType: string,
    resourceId: string | null,
    libraryId: string | null,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO audit_log (
         tenant_id, library_id, api_key_id, action, resource_type, resource_id, details
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [principal.tenantId, libraryId, principal.apiKeyId, action, resourceType, resourceId, details],
    );
  }

  private async libraryRecord(principal: Principal, libraryId: string): Promise<LibraryRecord> {
    this.assertLibraryAccess(principal, libraryId);
    const result = await this.database.query<LibraryRecord>(
      `SELECT id, name, slug, description, kind, filter_predicate, metadata,
              is_active, created_at, updated_at
         FROM libraries
        WHERE tenant_id = $1 AND id = $2 AND is_active = true`,
      [principal.tenantId, libraryId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Library not found');
    row.filter_predicate = row.filter_predicate == null
      ? null
      : LibraryFilterSchema.parse(row.filter_predicate);
    return row;
  }

  private membership(
    principal: Principal,
    library: LibraryRecord,
    parameters: unknown[],
    alias = 'c',
  ): string {
    const tenantParameter = parameters.push(principal.tenantId);
    const libraryParameter = parameters.push(library.id);
    return buildEffectiveMembership({
      contentAlias: alias,
      tenantParameter,
      libraryParameter,
      filter: library.filter_predicate as LibraryFilter | null,
      parameters,
    });
  }

  private async libraryCount(principal: Principal, library: LibraryRecord): Promise<number> {
    const parameters: unknown[] = [];
    const membership = this.membership(principal, library, parameters);
    const result = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM content_items c
        WHERE c.tenant_id = $1 AND c.status <> 'deleted' AND ${membership}`,
      parameters,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private async contentScope(principal: Principal, alias = 'c') {
    if (!principal.libraryId) {
      return { parameters: [principal.tenantId] as unknown[], membership: 'TRUE' };
    }
    const library = await this.libraryRecord(principal, principal.libraryId);
    const parameters: unknown[] = [];
    const membership = this.membership(principal, library, parameters, alias);
    return { parameters, membership };
  }

  async listTags(principal: Principal) {
    const scope = await this.contentScope(principal, 'scoped_c');
    const scopeJoin = principal.libraryId ? `AND EXISTS (
      SELECT 1 FROM content_tags scoped_ct
      JOIN content_items scoped_c
        ON scoped_c.tenant_id=scoped_ct.tenant_id AND scoped_c.id=scoped_ct.content_id
      WHERE scoped_ct.tenant_id=t.tenant_id AND scoped_ct.tag_id=t.id
        AND scoped_c.status <> 'deleted' AND ${scope.membership}
    )` : '';
    const result = await this.database.query(
      `SELECT id, slug, label, description, category, parent_id AS "parentId",
              color, metadata, is_active AS "isActive", created_at AS "createdAt",
              updated_at AS "updatedAt"
         FROM tags t
        WHERE tenant_id = $1 AND is_active = true ${scopeJoin}
        ORDER BY category NULLS FIRST, label, id`,
      scope.parameters,
    );
    return result.rows;
  }

  async createTag(principal: Principal, raw: TagCreate) {
    this.assertTenantAccess(principal);
    const input = TagCreateSchema.parse(raw);
    const result = await this.database.query(
      `INSERT INTO tags (
         tenant_id, slug, label, description, category, parent_id, color, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, slug, label, description, category, parent_id AS "parentId",
                 color, metadata, is_active AS "isActive", created_at AS "createdAt",
                 updated_at AS "updatedAt"`,
      [principal.tenantId, input.slug, input.label, input.description ?? null,
        input.category ?? null, input.parentId ?? null, input.color ?? null, input.metadata],
    );
    const tag = result.rows[0];
    await this.audit(principal, 'tag.create', 'tag', String((tag as { id: string }).id), null);
    return tag;
  }

  async updateTag(principal: Principal, id: string, raw: TagUpdate) {
    this.assertTenantAccess(principal);
    const input = TagUpdateSchema.parse(raw);
    const current = await this.database.query<TagCreate>(
      `SELECT slug, label, description, category, parent_id AS "parentId",
              color, metadata FROM tags
        WHERE tenant_id = $1 AND id = $2 AND is_active = true`,
      [principal.tenantId, id],
    );
    if (!current.rows[0]) throw new NotFoundError('Tag not found');
    const merged = TagCreateSchema.parse({ ...current.rows[0], ...input });
    const result = await this.database.query(
      `UPDATE tags SET slug=$3, label=$4, description=$5, category=$6,
              parent_id=$7, color=$8, metadata=$9
        WHERE tenant_id=$1 AND id=$2
        RETURNING id, slug, label, description, category, parent_id AS "parentId",
                  color, metadata, is_active AS "isActive", created_at AS "createdAt",
                  updated_at AS "updatedAt"`,
      [principal.tenantId, id, merged.slug, merged.label, merged.description ?? null,
        merged.category ?? null, merged.parentId ?? null, merged.color ?? null, merged.metadata],
    );
    await this.audit(principal, 'tag.update', 'tag', id, null, { fields: Object.keys(input) });
    return result.rows[0];
  }

  async deleteTag(principal: Principal, id: string): Promise<void> {
    this.assertTenantAccess(principal);
    const result = await this.database.query(
      `UPDATE tags SET is_active=false WHERE tenant_id=$1 AND id=$2 AND is_active=true`,
      [principal.tenantId, id],
    );
    if (!result.rowCount) throw new NotFoundError('Tag not found');
    await this.audit(principal, 'tag.delete', 'tag', id, null);
  }

  async assignTag(principal: Principal, tagId: string, raw: z.infer<typeof TagAssignmentSchema>, remove = false) {
    const input = TagAssignmentSchema.parse(raw);
    const scope = await this.contentScope(principal);
    const tagParameter = scope.parameters.push(tagId);
    const idsParameter = scope.parameters.push(input.contentIds);
    if (remove) {
      const result = await this.database.query(
        `DELETE FROM content_tags ct
          WHERE ct.tenant_id=$1 AND ct.tag_id=$${tagParameter}
            AND ct.content_id=ANY($${idsParameter}::uuid[])
            AND EXISTS (SELECT 1 FROM content_items c
              WHERE c.tenant_id=ct.tenant_id AND c.id=ct.content_id AND ${scope.membership})`,
        scope.parameters,
      );
      await this.audit(principal, 'tag.unassign', 'tag', tagId, principal.libraryId ?? null,
        { requested: input.contentIds.length, changed: result.rowCount ?? 0 });
      return { changed: result.rowCount ?? 0 };
    }
    const result = await this.database.query(
      `INSERT INTO content_tags (tenant_id, content_id, tag_id, applied_by)
       SELECT $1, c.id, $${tagParameter}, $${scope.parameters.push(principal.apiKeyId)}
         FROM content_items c
        WHERE c.tenant_id=$1 AND c.id=ANY($${idsParameter}::uuid[]) AND c.status <> 'deleted'
          AND ${scope.membership}
       ON CONFLICT DO NOTHING`,
      scope.parameters,
    );
    await this.audit(principal, 'tag.assign', 'tag', tagId, principal.libraryId ?? null,
      { requested: input.contentIds.length, changed: result.rowCount ?? 0 });
    return { changed: result.rowCount ?? 0 };
  }

  async listLibraries(principal: Principal) {
    const result = await this.database.query<LibraryRecord>(
      `SELECT id, name, slug, description, kind, filter_predicate, metadata,
              is_active, created_at, updated_at
         FROM libraries
        WHERE tenant_id=$1 AND is_active=true
          AND ($2::uuid IS NULL OR id=$2)
        ORDER BY (kind='system_all_content') DESC, name, id`,
      [principal.tenantId, principal.libraryId ?? null],
    );
    return Promise.all(result.rows.map(async (row) => {
      row.filter_predicate = row.filter_predicate == null ? null : LibraryFilterSchema.parse(row.filter_predicate);
      return publicLibrary(row, await this.libraryCount(principal, row));
    }));
  }

  async getLibrary(principal: Principal, id: string) {
    const row = await this.libraryRecord(principal, id);
    return publicLibrary(row, await this.libraryCount(principal, row));
  }

  async createLibrary(principal: Principal, raw: LibraryCreate) {
    this.assertTenantAccess(principal);
    const input = LibraryCreateSchema.parse(raw);
    const result = await this.database.query<LibraryRecord>(
      `INSERT INTO libraries (
         tenant_id, name, slug, description, filter_predicate, metadata, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, name, slug, description, kind, filter_predicate, metadata,
                 is_active, created_at, updated_at`,
      [principal.tenantId, input.name, input.slug, input.description ?? null,
        input.filter, input.metadata, principal.apiKeyId],
    );
    const row = result.rows[0] as LibraryRecord;
    await this.audit(principal, 'library.create', 'library', row.id, row.id);
    return publicLibrary(row, 0);
  }

  async updateLibrary(principal: Principal, id: string, raw: LibraryUpdate) {
    this.assertTenantAccess(principal);
    const input = LibraryUpdateSchema.parse(raw);
    const current = await this.libraryRecord(principal, id);
    if (current.kind === 'system_all_content'
        && (input.name !== undefined || input.slug !== undefined || input.filter !== undefined)) {
      throw new ConflictError('The all-content system library name, slug, and filter are immutable');
    }
    const result = await this.database.query<LibraryRecord>(
      `UPDATE libraries SET name=$3, slug=$4, description=$5,
              filter_predicate=$6, metadata=$7
        WHERE tenant_id=$1 AND id=$2
        RETURNING id, name, slug, description, kind, filter_predicate, metadata,
                  is_active, created_at, updated_at`,
      [principal.tenantId, id, input.name ?? current.name, input.slug ?? current.slug,
        input.description === undefined ? current.description : input.description,
        input.filter === undefined ? current.filter_predicate : input.filter,
        input.metadata ?? current.metadata],
    );
    const row = result.rows[0] as LibraryRecord;
    await this.audit(principal, 'library.update', 'library', id, id, { fields: Object.keys(input) });
    return publicLibrary(row, await this.libraryCount(principal, row));
  }

  async deleteLibrary(principal: Principal, id: string): Promise<void> {
    this.assertTenantAccess(principal);
    const current = await this.libraryRecord(principal, id);
    if (current.kind === 'system_all_content') throw new ConflictError('The all-content system library cannot be deleted');
    await this.database.query(`UPDATE libraries SET is_active=false WHERE tenant_id=$1 AND id=$2`, [principal.tenantId, id]);
    await this.audit(principal, 'library.delete', 'library', id, id);
  }

  private async memberPage(
    principal: Principal,
    library: LibraryRecord,
    raw: z.infer<typeof LibraryMembersSchema>,
    filterOverride?: LibraryFilter | null,
  ) {
    const input = LibraryMembersSchema.parse(raw);
    const effectiveLibrary = { ...library, filter_predicate: filterOverride === undefined ? library.filter_predicate : filterOverride };
    const parameters: unknown[] = [];
    const membership = this.membership(principal, effectiveLibrary, parameters);
    const conditions = [`c.tenant_id=$1`, `c.status <> 'deleted'`, membership];
    if (input.query) {
      const queryParameter = parameters.push(input.query);
      conditions.push(`c.search_vector @@ websearch_to_tsquery('english', $${queryParameter})`);
    }
    if (input.cursor) {
      const [date, id] = decodeCursor(input.cursor);
      const dateParameter = parameters.push(date);
      const idParameter = parameters.push(id);
      conditions.push(`(c.created_at,c.id) < ($${dateParameter}::timestamptz,$${idParameter}::uuid)`);
    }
    const limitParameter = parameters.push(input.limit + 1);
    const result = await this.database.query<{
      id: string; title: string; contentType: string; source: string; summary: string | null; createdAt: Date;
    }>(
      `SELECT c.id, c.title, c.content_type AS "contentType", c.source, c.summary,
              c.created_at AS "createdAt"
         FROM content_items c
        WHERE ${conditions.join(' AND ')}
        ORDER BY c.created_at DESC,c.id DESC LIMIT $${limitParameter}`,
      parameters,
    );
    const hasMore = result.rows.length > input.limit;
    const items = result.rows.slice(0, input.limit);
    return {
      items,
      hasMore,
      nextCursor: hasMore && items.length
        ? encodeCursor(items[items.length - 1]!.createdAt, items[items.length - 1]!.id)
        : null,
    };
  }

  async listLibraryMembers(principal: Principal, id: string, raw: z.infer<typeof LibraryMembersSchema>) {
    const library = await this.libraryRecord(principal, id);
    const page = await this.memberPage(principal, library, raw);
    await this.audit(principal, 'library.members.read', 'library', id, id, { count: page.items.length });
    return page;
  }

  async previewLibrary(principal: Principal, id: string, raw: z.infer<typeof LibraryPreviewSchema>) {
    const input = LibraryPreviewSchema.parse(raw);
    const library = await this.libraryRecord(principal, id);
    return this.memberPage(principal, library, { limit: input.limit }, input.filter);
  }

  async setManualMembership(
    principal: Principal,
    libraryId: string,
    contentId: string,
    mode: 'include' | 'exclude',
    remove: boolean,
  ) {
    this.assertTenantAccess(principal);
    await this.libraryRecord(principal, libraryId);
    const table = mode === 'include' ? 'library_manual_includes' : 'library_manual_excludes';
    if (remove) {
      await this.database.query(
        `DELETE FROM ${table} WHERE tenant_id=$1 AND library_id=$2 AND content_id=$3`,
        [principal.tenantId, libraryId, contentId],
      );
    } else {
      const result = await this.database.query(
        `INSERT INTO ${table} (tenant_id,library_id,content_id,added_by)
         SELECT $1,$2,c.id,$4 FROM content_items c
          WHERE c.tenant_id=$1 AND c.id=$3 AND c.status <> 'deleted'
         ON CONFLICT DO NOTHING`,
        [principal.tenantId, libraryId, contentId, principal.apiKeyId],
      );
      if (!result.rowCount) {
        const exists = await this.database.query(
          `SELECT 1 FROM ${table} WHERE tenant_id=$1 AND library_id=$2 AND content_id=$3`,
          [principal.tenantId, libraryId, contentId],
        );
        if (!exists.rows[0]) throw new NotFoundError('Content not found');
      }
    }
    await this.audit(principal, `library.${mode}.${remove ? 'remove' : 'add'}`, 'content', contentId, libraryId);
    return { libraryId, contentId, mode, active: !remove };
  }

  async listRecipes(principal: Principal, libraryId: string) {
    await this.libraryRecord(principal, libraryId);
    const result = await this.database.query(
      `SELECT id, library_id AS "libraryId", name, description,
              content_types AS "contentTypes", system_prompt AS "systemPrompt",
              user_prompt_template AS "userPromptTemplate", output_type AS "outputType",
              output_schema AS "outputSchema", model_id AS "modelId", max_tokens AS "maxTokens",
              is_active AS "isActive", current_version AS "currentVersion",
              prompt_hash AS "promptHash", created_at AS "createdAt", updated_at AS "updatedAt"
         FROM library_recipes
        WHERE tenant_id=$1 AND library_id=$2
        ORDER BY name,id`,
      [principal.tenantId, libraryId],
    );
    return result.rows;
  }

  private async recipe(principal: Principal, libraryId: string, recipeId: string) {
    await this.libraryRecord(principal, libraryId);
    const result = await this.database.query<RecipeCreate & {
      id: string; currentVersion: number; promptHash: string; createdAt: Date; updatedAt: Date;
    }>(
      `SELECT id, name, description, content_types AS "contentTypes",
              system_prompt AS "systemPrompt", user_prompt_template AS "userPromptTemplate",
              output_type AS "outputType", output_schema AS "outputSchema",
              model_id AS "modelId", max_tokens AS "maxTokens", is_active AS "isActive",
              current_version AS "currentVersion", prompt_hash AS "promptHash",
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM library_recipes
        WHERE tenant_id=$1 AND library_id=$2 AND id=$3`,
      [principal.tenantId, libraryId, recipeId],
    );
    if (!result.rows[0]) throw new NotFoundError('Recipe not found');
    return result.rows[0];
  }

  async createRecipe(principal: Principal, libraryId: string, raw: RecipeCreate) {
    await this.libraryRecord(principal, libraryId);
    const input = RecipeCreateSchema.parse(raw);
    const hash = promptHash(input);
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ id: string } & Record<string, unknown>>(
        `INSERT INTO library_recipes (
           tenant_id,library_id,name,description,content_types,system_prompt,
           user_prompt_template,output_type,output_schema,model_id,max_tokens,
           is_active,prompt_hash,created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id, library_id AS "libraryId", name, description,
                   content_types AS "contentTypes", system_prompt AS "systemPrompt",
                   user_prompt_template AS "userPromptTemplate", output_type AS "outputType",
                   output_schema AS "outputSchema", model_id AS "modelId", max_tokens AS "maxTokens",
                   is_active AS "isActive", current_version AS "currentVersion",
                   prompt_hash AS "promptHash", created_at AS "createdAt", updated_at AS "updatedAt"`,
        [principal.tenantId, libraryId, input.name, input.description ?? null,
          input.contentTypes, input.systemPrompt, input.userPromptTemplate, input.outputType,
          input.outputSchema ?? null, input.modelId ?? null, input.maxTokens ?? null,
          input.isActive, hash, principal.apiKeyId],
      );
      const recipeId = result.rows[0]!.id;
      await client.query(
        `INSERT INTO library_recipe_versions (
           tenant_id,recipe_id,version,content_types,system_prompt,user_prompt_template,
           output_type,output_schema,model_id,max_tokens,prompt_hash,saved_by
         ) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [principal.tenantId, recipeId, input.contentTypes, input.systemPrompt,
          input.userPromptTemplate, input.outputType, input.outputSchema ?? null,
          input.modelId ?? null, input.maxTokens ?? null, hash, principal.apiKeyId],
      );
      await client.query('COMMIT');
      await this.audit(principal, 'recipe.create', 'recipe', recipeId, libraryId);
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateRecipe(principal: Principal, libraryId: string, recipeId: string, raw: RecipeUpdate) {
    const input = RecipeUpdateSchema.parse(raw);
    const current = await this.recipe(principal, libraryId, recipeId);
    const merged = RecipeCreateSchema.parse({
      name: current.name,
      description: current.description,
      contentTypes: current.contentTypes,
      systemPrompt: current.systemPrompt,
      userPromptTemplate: current.userPromptTemplate,
      outputType: current.outputType,
      outputSchema: current.outputSchema,
      modelId: current.modelId,
      maxTokens: current.maxTokens,
      isActive: current.isActive,
      ...input,
    });
    const version = current.currentVersion + 1;
    const hash = promptHash(merged);
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE library_recipes SET name=$4,description=$5,content_types=$6,
                system_prompt=$7,user_prompt_template=$8,output_type=$9,output_schema=$10,
                model_id=$11,max_tokens=$12,is_active=$13,current_version=$14,prompt_hash=$15
          WHERE tenant_id=$1 AND library_id=$2 AND id=$3
          RETURNING id, library_id AS "libraryId", name, description,
                    content_types AS "contentTypes", system_prompt AS "systemPrompt",
                    user_prompt_template AS "userPromptTemplate", output_type AS "outputType",
                    output_schema AS "outputSchema", model_id AS "modelId", max_tokens AS "maxTokens",
                    is_active AS "isActive", current_version AS "currentVersion",
                    prompt_hash AS "promptHash", created_at AS "createdAt", updated_at AS "updatedAt"`,
        [principal.tenantId, libraryId, recipeId, merged.name, merged.description ?? null,
          merged.contentTypes, merged.systemPrompt, merged.userPromptTemplate, merged.outputType,
          merged.outputSchema ?? null, merged.modelId ?? null, merged.maxTokens ?? null,
          merged.isActive, version, hash],
      );
      await client.query(
        `INSERT INTO library_recipe_versions (
           tenant_id,recipe_id,version,content_types,system_prompt,user_prompt_template,
           output_type,output_schema,model_id,max_tokens,prompt_hash,saved_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [principal.tenantId, recipeId, version, merged.contentTypes, merged.systemPrompt,
          merged.userPromptTemplate, merged.outputType, merged.outputSchema ?? null,
          merged.modelId ?? null, merged.maxTokens ?? null, hash, principal.apiKeyId],
      );
      await client.query('COMMIT');
      await this.audit(principal, 'recipe.update', 'recipe', recipeId, libraryId, { version });
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteRecipe(principal: Principal, libraryId: string, recipeId: string): Promise<void> {
    await this.recipe(principal, libraryId, recipeId);
    await this.database.query(
      `UPDATE library_recipes SET is_active=false WHERE tenant_id=$1 AND library_id=$2 AND id=$3`,
      [principal.tenantId, libraryId, recipeId],
    );
    await this.audit(principal, 'recipe.delete', 'recipe', recipeId, libraryId);
  }

  async previewRecipe(
    principal: Principal,
    libraryId: string,
    recipeId: string,
    raw: z.infer<typeof RecipePreviewSchema>,
  ) {
    const input = RecipePreviewSchema.parse(raw);
    const recipe = await this.recipe(principal, libraryId, recipeId);
    const library = await this.libraryRecord(principal, libraryId);
    const parameters: unknown[] = [];
    const membership = this.membership(principal, library, parameters);
    const contentTypesParameter = parameters.push(recipe.contentTypes);
    const selected = input.contentIds?.length
      ? `AND c.id=ANY($${parameters.push(input.contentIds)}::uuid[])`
      : '';
    const limitParameter = parameters.push(input.limit);
    const rows = await this.database.query<{
      id: string; title: string; content: string | null; summary: string | null;
    }>(
      `SELECT c.id,c.title,c.content,c.summary FROM content_items c
        WHERE c.tenant_id=$1 AND c.status='active' AND ${membership}
          AND c.content_type=ANY($${contentTypesParameter}::text[]) ${selected}
        ORDER BY c.created_at DESC,c.id DESC LIMIT $${limitParameter}`,
      parameters,
    );
    const previews = [];
    for (const row of rows.rows) {
      const completion = await this.language.complete({
        system: recipe.systemPrompt,
        prompt: recipe.userPromptTemplate.replace('{{content}}', row.content ?? row.summary ?? ''),
        model: recipe.modelId ?? undefined,
        maxTokens: recipe.maxTokens ?? undefined,
        responseFormat: recipeResponseFormat(recipe.outputSchema),
      });
      previews.push({ contentId: row.id, title: row.title, output: completion.text,
        outputData: parseRecipeOutput(completion.text, recipe.outputSchema),
        modelId: completion.model, provider: completion.provider });
    }
    await this.audit(principal, 'recipe.preview', 'recipe', recipeId, libraryId, { count: previews.length });
    return { items: previews };
  }

  async runRecipe(principal: Principal, libraryId: string, recipeId: string) {
    const recipe = await this.recipe(principal, libraryId, recipeId);
    if (!recipe.isActive) throw new ConflictError('Recipe is inactive');
    const library = await this.libraryRecord(principal, libraryId);
    const total = await this.libraryCount(principal, library);
    const result = await this.database.query(
      `INSERT INTO library_recipe_runs (
         tenant_id,library_id,recipe_id,recipe_version,total_count,requested_by
       ) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id,library_id AS "libraryId",recipe_id AS "recipeId",
                 recipe_version AS "recipeVersion",status,total_count AS "totalCount",
                 processed_count AS "processedCount",succeeded_count AS "succeededCount",
                 skipped_count AS "skippedCount",failed_count AS "failedCount",
                 created_at AS "createdAt",updated_at AS "updatedAt"`,
      [principal.tenantId, libraryId, recipeId, recipe.currentVersion, total, principal.apiKeyId],
    );
    const run = result.rows[0] as { id: string };
    await this.audit(principal, 'recipe.run', 'recipe_run', run.id, libraryId, { recipeId });
    return run;
  }

  async listRecipeRuns(principal: Principal, libraryId: string, recipeId: string) {
    await this.recipe(principal, libraryId, recipeId);
    const result = await this.database.query(
      `SELECT id,library_id AS "libraryId",recipe_id AS "recipeId",
              recipe_version AS "recipeVersion",status,total_count AS "totalCount",
              processed_count AS "processedCount",succeeded_count AS "succeededCount",
              skipped_count AS "skippedCount",failed_count AS "failedCount",
              error_message AS "errorMessage",started_at AS "startedAt",
              completed_at AS "completedAt",created_at AS "createdAt",updated_at AS "updatedAt"
         FROM library_recipe_runs
        WHERE tenant_id=$1 AND library_id=$2 AND recipe_id=$3
        ORDER BY created_at DESC,id DESC LIMIT 100`,
      [principal.tenantId, libraryId, recipeId],
    );
    return result.rows;
  }

  async getRecipeRun(principal: Principal, libraryId: string, runId: string) {
    await this.libraryRecord(principal, libraryId);
    const run = await this.database.query(
      `SELECT id,library_id AS "libraryId",recipe_id AS "recipeId",
              recipe_version AS "recipeVersion",status,total_count AS "totalCount",
              processed_count AS "processedCount",succeeded_count AS "succeededCount",
              skipped_count AS "skippedCount",failed_count AS "failedCount",
              error_message AS "errorMessage",started_at AS "startedAt",
              completed_at AS "completedAt",created_at AS "createdAt",updated_at AS "updatedAt"
         FROM library_recipe_runs WHERE tenant_id=$1 AND library_id=$2 AND id=$3`,
      [principal.tenantId, libraryId, runId],
    );
    if (!run.rows[0]) throw new NotFoundError('Recipe run not found');
    const items = await this.database.query(
      `SELECT id,content_id AS "contentId",artifact_id AS "artifactId",status,
              output_preview AS "outputPreview",output_data AS "outputData",
              error_message AS "errorMessage",started_at AS "startedAt",
              completed_at AS "completedAt",created_at AS "createdAt"
         FROM library_recipe_run_items
        WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at,id`,
      [principal.tenantId, runId],
    );
    return { ...run.rows[0] as Record<string, unknown>, items: items.rows };
  }

  async cancelRecipeRun(principal: Principal, libraryId: string, runId: string) {
    await this.libraryRecord(principal, libraryId);
    const result = await this.database.query(
      `UPDATE library_recipe_runs SET status='canceled',completed_at=NOW()
        WHERE tenant_id=$1 AND library_id=$2 AND id=$3 AND status IN ('queued','running')
        RETURNING id,status`,
      [principal.tenantId, libraryId, runId],
    );
    if (!result.rows[0]) throw new ConflictError('Recipe run cannot be canceled');
    await this.audit(principal, 'recipe_run.cancel', 'recipe_run', runId, libraryId);
    return result.rows[0];
  }

  async retryRecipeRun(principal: Principal, libraryId: string, runId: string) {
    const run = await this.getRecipeRun(principal, libraryId, runId) as Record<string, unknown>;
    if (!['failed', 'partial_success', 'canceled'].includes(String(run.status))) {
      throw new ConflictError('Only failed, partial, or canceled recipe runs can be retried');
    }
    return this.runRecipe(principal, libraryId, z.string().uuid().parse(run.recipeId));
  }

  async listArtifacts(principal: Principal, contentId: string) {
    const scope = await this.contentScope(principal);
    const contentParameter = scope.parameters.push(contentId);
    const content = await this.database.query(
      `SELECT c.id FROM content_items c
        WHERE c.tenant_id=$1 AND c.id=$${contentParameter} AND c.status <> 'deleted'
          AND ${scope.membership}`,
      scope.parameters,
    );
    if (!content.rows[0]) throw new NotFoundError('Content not found');
    const result = await this.database.query(
      `SELECT id,content_id AS "contentId",artifact_type AS "artifactType",
              text_content AS "textContent",data_json AS "dataJson",
              source_content_ids AS "sourceContentIds",supersedes_id AS "supersedesId",
              recipe_id AS "recipeId",recipe_run_id AS "recipeRunId",
              recipe_version AS "recipeVersion",prompt_hash AS "promptHash",
              model_id AS "modelId",status,version,is_current AS "isCurrent",
              metadata,created_at AS "createdAt",updated_at AS "updatedAt"
         FROM content_artifacts
        WHERE tenant_id=$1 AND content_id=$2
        ORDER BY artifact_type,recipe_id NULLS FIRST,version DESC,created_at DESC`,
      [principal.tenantId, contentId],
    );
    return result.rows;
  }

  async getArtifact(principal: Principal, artifactId: string) {
    const scope = await this.contentScope(principal);
    const artifactParameter = scope.parameters.push(artifactId);
    const result = await this.database.query(
      `SELECT a.id,a.content_id AS "contentId",a.artifact_type AS "artifactType",
              a.text_content AS "textContent",a.data_json AS "dataJson",
              a.source_content_ids AS "sourceContentIds",a.supersedes_id AS "supersedesId",
              a.recipe_id AS "recipeId",a.recipe_run_id AS "recipeRunId",
              a.recipe_version AS "recipeVersion",a.prompt_hash AS "promptHash",
              a.model_id AS "modelId",a.status,a.version,a.is_current AS "isCurrent",
              a.metadata,a.created_at AS "createdAt",a.updated_at AS "updatedAt"
         FROM content_artifacts a
         JOIN content_items c ON c.tenant_id=a.tenant_id AND c.id=a.content_id
        WHERE a.tenant_id=$1 AND a.id=$${artifactParameter} AND c.status <> 'deleted'
          AND ${scope.membership}`,
      scope.parameters,
    );
    if (!result.rows[0]) throw new NotFoundError('Artifact not found');
    return result.rows[0];
  }

  async listReports(principal: Principal, libraryId: string) {
    await this.libraryRecord(principal, libraryId);
    const result = await this.database.query(
      `SELECT id,library_id AS "libraryId",title,slug,description,prompt,schedule,
              is_active AS "isActive",created_at AS "createdAt",updated_at AS "updatedAt"
         FROM library_reports WHERE tenant_id=$1 AND library_id=$2
        ORDER BY title,id`,
      [principal.tenantId, libraryId],
    );
    return result.rows;
  }

  private async report(principal: Principal, libraryId: string, reportId: string) {
    await this.libraryRecord(principal, libraryId);
    const result = await this.database.query<ReportCreate & { id: string }>(
      `SELECT id,title,slug,description,prompt,schedule,is_active AS "isActive"
         FROM library_reports WHERE tenant_id=$1 AND library_id=$2 AND id=$3`,
      [principal.tenantId, libraryId, reportId],
    );
    if (!result.rows[0]) throw new NotFoundError('Report not found');
    return result.rows[0];
  }

  async createReport(principal: Principal, libraryId: string, raw: ReportCreate) {
    await this.libraryRecord(principal, libraryId);
    const input = ReportCreateSchema.parse(raw);
    const result = await this.database.query(
      `INSERT INTO library_reports (
         tenant_id,library_id,title,slug,description,prompt,schedule,is_active,created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id,library_id AS "libraryId",title,slug,description,prompt,schedule,
                 is_active AS "isActive",created_at AS "createdAt",updated_at AS "updatedAt"`,
      [principal.tenantId, libraryId, input.title, input.slug, input.description ?? null,
        input.prompt, input.schedule ?? null, input.isActive, principal.apiKeyId],
    );
    const report = result.rows[0] as { id: string };
    await this.audit(principal, 'report.create', 'report', report.id, libraryId);
    return report;
  }

  async updateReport(principal: Principal, libraryId: string, reportId: string, raw: ReportUpdate) {
    const input = ReportUpdateSchema.parse(raw);
    const current = await this.report(principal, libraryId, reportId);
    const merged = ReportCreateSchema.parse({
      title: current.title,
      slug: current.slug,
      description: current.description,
      prompt: current.prompt,
      schedule: current.schedule,
      isActive: current.isActive,
      ...input,
    });
    const result = await this.database.query(
      `UPDATE library_reports SET title=$4,slug=$5,description=$6,prompt=$7,
              schedule=$8,is_active=$9
        WHERE tenant_id=$1 AND library_id=$2 AND id=$3
        RETURNING id,library_id AS "libraryId",title,slug,description,prompt,schedule,
                  is_active AS "isActive",created_at AS "createdAt",updated_at AS "updatedAt"`,
      [principal.tenantId, libraryId, reportId, merged.title, merged.slug,
        merged.description ?? null, merged.prompt, merged.schedule ?? null, merged.isActive],
    );
    await this.audit(principal, 'report.update', 'report', reportId, libraryId);
    return result.rows[0];
  }

  async deleteReport(principal: Principal, libraryId: string, reportId: string): Promise<void> {
    await this.report(principal, libraryId, reportId);
    await this.database.query(
      `DELETE FROM library_reports WHERE tenant_id=$1 AND library_id=$2 AND id=$3`,
      [principal.tenantId, libraryId, reportId],
    );
    await this.audit(principal, 'report.delete', 'report', reportId, libraryId);
  }

  async generateReport(principal: Principal, libraryId: string, reportId: string) {
    const report = await this.report(principal, libraryId, reportId);
    const result = await this.database.query(
      `INSERT INTO generated_reports (
         tenant_id,library_id,report_id,title,requested_by
       ) VALUES ($1,$2,$3,$4,$5)
       RETURNING id,library_id AS "libraryId",report_id AS "reportId",status,title,
                 body,source_content_ids AS "sourceContentIds",model_id AS "modelId",
                 error_message AS "errorMessage",created_at AS "createdAt",
                 updated_at AS "updatedAt"`,
      [principal.tenantId, libraryId, reportId, report.title, principal.apiKeyId],
    );
    const generated = result.rows[0] as { id: string };
    await this.audit(principal, 'report.generate', 'generated_report', generated.id, libraryId, { reportId });
    return generated;
  }

  async listGeneratedReports(principal: Principal, libraryId: string, reportId: string) {
    await this.report(principal, libraryId, reportId);
    const result = await this.database.query(
      `SELECT id,library_id AS "libraryId",report_id AS "reportId",status,title,body,
              source_content_ids AS "sourceContentIds",model_id AS "modelId",
              error_message AS "errorMessage",started_at AS "startedAt",
              completed_at AS "completedAt",created_at AS "createdAt",updated_at AS "updatedAt"
         FROM generated_reports
        WHERE tenant_id=$1 AND library_id=$2 AND report_id=$3
        ORDER BY created_at DESC,id DESC`,
      [principal.tenantId, libraryId, reportId],
    );
    return result.rows;
  }

  async cancelGeneratedReport(
    principal: Principal,
    libraryId: string,
    reportId: string,
    generatedId: string,
  ) {
    await this.report(principal, libraryId, reportId);
    const result = await this.database.query(
      `UPDATE generated_reports SET status='canceled',completed_at=NOW()
        WHERE tenant_id=$1 AND library_id=$2 AND report_id=$3 AND id=$4
          AND status IN ('queued','running') RETURNING id,status`,
      [principal.tenantId, libraryId, reportId, generatedId],
    );
    if (!result.rows[0]) throw new ConflictError('Generated report cannot be canceled');
    await this.audit(principal, 'report.cancel', 'generated_report', generatedId, libraryId);
    return result.rows[0];
  }

  async retryGeneratedReport(
    principal: Principal,
    libraryId: string,
    reportId: string,
    generatedId: string,
  ) {
    await this.report(principal, libraryId, reportId);
    const existing = await this.database.query<{ status: string }>(
      `SELECT status FROM generated_reports
        WHERE tenant_id=$1 AND library_id=$2 AND report_id=$3 AND id=$4`,
      [principal.tenantId, libraryId, reportId, generatedId],
    );
    if (!existing.rows[0] || !['failed', 'canceled'].includes(existing.rows[0].status)) {
      throw new ConflictError('Only failed or canceled reports can be retried');
    }
    return this.generateReport(principal, libraryId, reportId);
  }

  async listDashboards(principal: Principal, libraryId: string) {
    await this.libraryRecord(principal, libraryId);
    const result = await this.database.query(
      `SELECT id,library_id AS "libraryId",name,description,layout,widgets,
              created_at AS "createdAt",updated_at AS "updatedAt"
         FROM dashboards WHERE tenant_id=$1 AND library_id=$2 ORDER BY name,id`,
      [principal.tenantId, libraryId],
    );
    return result.rows;
  }

  async createDashboard(principal: Principal, libraryId: string, raw: DashboardCreate) {
    await this.libraryRecord(principal, libraryId);
    const input = DashboardCreateSchema.parse(raw);
    const result = await this.database.query(
      `INSERT INTO dashboards (tenant_id,library_id,name,description,layout,widgets,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id,library_id AS "libraryId",name,description,layout,widgets,
                 created_at AS "createdAt",updated_at AS "updatedAt"`,
      [principal.tenantId, libraryId, input.name, input.description ?? null,
        JSON.stringify(input.layout), JSON.stringify(input.widgets), principal.apiKeyId],
    );
    const dashboard = result.rows[0] as { id: string };
    await this.audit(principal, 'dashboard.create', 'dashboard', dashboard.id, libraryId);
    return dashboard;
  }

  async updateDashboard(principal: Principal, libraryId: string, dashboardId: string, raw: DashboardUpdate) {
    await this.libraryRecord(principal, libraryId);
    const input = DashboardUpdateSchema.parse(raw);
    const current = await this.database.query<DashboardCreate>(
      `SELECT name,description,layout,widgets FROM dashboards
        WHERE tenant_id=$1 AND library_id=$2 AND id=$3`,
      [principal.tenantId, libraryId, dashboardId],
    );
    if (!current.rows[0]) throw new NotFoundError('Dashboard not found');
    const merged = DashboardCreateSchema.parse({ ...current.rows[0], ...input });
    const result = await this.database.query(
      `UPDATE dashboards SET name=$4,description=$5,layout=$6,widgets=$7
        WHERE tenant_id=$1 AND library_id=$2 AND id=$3
        RETURNING id,library_id AS "libraryId",name,description,layout,widgets,
                  created_at AS "createdAt",updated_at AS "updatedAt"`,
      [principal.tenantId, libraryId, dashboardId, merged.name,
        merged.description ?? null, JSON.stringify(merged.layout), JSON.stringify(merged.widgets)],
    );
    await this.audit(principal, 'dashboard.update', 'dashboard', dashboardId, libraryId);
    return result.rows[0];
  }

  async deleteDashboard(principal: Principal, libraryId: string, dashboardId: string): Promise<void> {
    await this.libraryRecord(principal, libraryId);
    const result = await this.database.query(
      `DELETE FROM dashboards WHERE tenant_id=$1 AND library_id=$2 AND id=$3`,
      [principal.tenantId, libraryId, dashboardId],
    );
    if (!result.rowCount) throw new NotFoundError('Dashboard not found');
    await this.audit(principal, 'dashboard.delete', 'dashboard', dashboardId, libraryId);
  }

  async listBatchJobs(principal: Principal, raw: z.infer<typeof PageSchema>) {
    const input = PageSchema.parse(raw);
    const parameters: unknown[] = [principal.tenantId, principal.libraryId ?? null];
    let cursor = '';
    if (input.cursor) {
      const [date, id] = decodeCursor(input.cursor);
      parameters.push(date, id);
      cursor = 'AND (created_at,id) < ($3::timestamptz,$4::uuid)';
    }
    parameters.push(input.limit + 1);
    const result = await this.database.query<{
      id: string; createdAt: Date;
    } & Record<string, unknown>>(
      `SELECT id,library_id AS "libraryId",kind,name,status,input,
              total_count AS "totalCount",processed_count AS "processedCount",
              succeeded_count AS "succeededCount",failed_count AS "failedCount",
              error_message AS "errorMessage",started_at AS "startedAt",
              completed_at AS "completedAt",created_at AS "createdAt",updated_at AS "updatedAt"
         FROM batch_jobs
        WHERE tenant_id=$1 AND ($2::uuid IS NULL OR library_id=$2) ${cursor}
        ORDER BY created_at DESC,id DESC LIMIT $${parameters.length}`,
      parameters,
    );
    const hasMore = result.rows.length > input.limit;
    const items = result.rows.slice(0, input.limit);
    return { items, hasMore, nextCursor: hasMore && items.length
      ? encodeCursor(items[items.length - 1]!.createdAt, items[items.length - 1]!.id)
      : null };
  }

  async createBatchJob(principal: Principal, raw: z.infer<typeof BatchJobCreateSchema>) {
    const input = BatchJobCreateSchema.parse(raw);
    const libraryId = input.libraryId ?? principal.libraryId ?? null;
    if (libraryId) await this.libraryRecord(principal, libraryId);
    else this.assertTenantAccess(principal);
    const jobInput = { ...input.input, ...(input.contentIds ? { contentIds: input.contentIds } : {}) };
    const total = input.contentIds?.length ?? 0;
    const result = await this.database.query(
      `INSERT INTO batch_jobs (
         tenant_id,library_id,kind,name,input,total_count,requested_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id,library_id AS "libraryId",kind,name,status,input,
                 total_count AS "totalCount",processed_count AS "processedCount",
                 succeeded_count AS "succeededCount",failed_count AS "failedCount",
                 created_at AS "createdAt",updated_at AS "updatedAt"`,
      [principal.tenantId, libraryId, input.kind, input.name, jobInput, total, principal.apiKeyId],
    );
    const job = result.rows[0] as { id: string };
    await this.audit(principal, 'batch.create', 'batch_job', job.id, libraryId);
    return job;
  }

  async getBatchJob(
    principal: Principal,
    jobId: string,
  ): Promise<Record<string, unknown> & { results: unknown[] }> {
    const result = await this.database.query(
      `SELECT id,library_id AS "libraryId",kind,name,status,input,
              total_count AS "totalCount",processed_count AS "processedCount",
              succeeded_count AS "succeededCount",failed_count AS "failedCount",
              error_message AS "errorMessage",started_at AS "startedAt",
              completed_at AS "completedAt",created_at AS "createdAt",updated_at AS "updatedAt"
         FROM batch_jobs
        WHERE tenant_id=$1 AND id=$2 AND ($3::uuid IS NULL OR library_id=$3)`,
      [principal.tenantId, jobId, principal.libraryId ?? null],
    );
    if (!result.rows[0]) throw new NotFoundError('Batch job not found');
    const results = await this.database.query(
      `SELECT id,content_id AS "contentId",status,output,error_message AS "errorMessage",
              created_at AS "createdAt"
         FROM batch_job_results WHERE tenant_id=$1 AND job_id=$2 ORDER BY created_at,id`,
      [principal.tenantId, jobId],
    );
    const job = result.rows[0] as Record<string, unknown>;
    return { ...job, results: results.rows as unknown[] };
  }

  async cancelBatchJob(principal: Principal, jobId: string) {
    const job = await this.getBatchJob(principal, jobId);
    const result = await this.database.query(
      `UPDATE batch_jobs SET status='canceled',completed_at=NOW()
        WHERE tenant_id=$1 AND id=$2 AND status IN ('queued','running')
        RETURNING id,status`,
      [principal.tenantId, jobId],
    );
    if (!result.rows[0]) throw new ConflictError('Batch job cannot be canceled');
    await this.audit(principal, 'batch.cancel', 'batch_job', jobId,
      (job.libraryId as string | null) ?? null);
    return result.rows[0];
  }

  async retryBatchJob(principal: Principal, jobId: string) {
    const job = await this.getBatchJob(principal, jobId);
    if (!['failed', 'partial_success', 'canceled'].includes(String(job.status))) {
      throw new ConflictError('Only failed, partial, or canceled jobs can be retried');
    }
    const input = z.record(z.unknown()).parse(job.input);
    const contentIds = z.array(z.string().uuid()).max(10_000).optional()
      .parse(input.contentIds);
    return this.createBatchJob(principal, {
      libraryId: (job.libraryId as string | null) ?? undefined,
      kind: z.enum(['prompt', 'export', 'import']).parse(job.kind),
      name: `${String(job.name)} retry`,
      input,
      contentIds,
    });
  }

  async listAccessTokens(principal: Principal) {
    this.assertTenantAccess(principal);
    const result = await this.database.query(
      `SELECT id,library_id AS "libraryId",key_prefix AS "keyPrefix",name,description,
              capabilities,last_used_at AS "lastUsedAt",expires_at AS "expiresAt",
              revoked_at AS "revokedAt",created_at AS "createdAt",updated_at AS "updatedAt"
         FROM api_keys WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC`,
      [principal.tenantId],
    );
    return result.rows;
  }

  async createAccessToken(principal: Principal, raw: z.infer<typeof AccessTokenCreateSchema>) {
    this.assertTenantAccess(principal);
    const input = AccessTokenCreateSchema.parse(raw);
    if (input.libraryId) await this.libraryRecord(principal, input.libraryId);
    const token = `ae_live_${randomBytes(32).toString('base64url')}`;
    const result = await this.database.query(
      `INSERT INTO api_keys (
         tenant_id,library_id,key_hash,key_prefix,name,description,capabilities,expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id,library_id AS "libraryId",key_prefix AS "keyPrefix",name,description,
                 capabilities,expires_at AS "expiresAt",created_at AS "createdAt"`,
      [principal.tenantId, input.libraryId ?? null, hashApiKey(token), token.slice(0, 16),
        input.name, input.description ?? null, JSON.stringify(input.capabilities), input.expiresAt ?? null],
    );
    const created = result.rows[0] as { id: string };
    await this.audit(principal, 'access_token.create', 'access_token', created.id,
      input.libraryId ?? null);
    return { ...created, token };
  }

  async updateAccessToken(
    principal: Principal,
    tokenId: string,
    raw: z.infer<typeof AccessTokenUpdateSchema>,
  ) {
    this.assertTenantAccess(principal);
    const input = AccessTokenUpdateSchema.parse(raw);
    const result = await this.database.query(
      `UPDATE api_keys SET
         name=CASE WHEN $3::boolean THEN $4 ELSE name END,
         description=CASE WHEN $5::boolean THEN $6 ELSE description END,
         expires_at=CASE WHEN $7::boolean THEN $8::timestamptz ELSE expires_at END
       WHERE tenant_id=$1 AND id=$2 AND revoked_at IS NULL
       RETURNING id,library_id AS "libraryId",key_prefix AS "keyPrefix",name,description,
                 capabilities,last_used_at AS "lastUsedAt",expires_at AS "expiresAt",
                 revoked_at AS "revokedAt",created_at AS "createdAt",updated_at AS "updatedAt"`,
      [principal.tenantId, tokenId,
        input.name !== undefined, input.name ?? null,
        input.description !== undefined, input.description ?? null,
        input.expiresAt !== undefined, input.expiresAt ?? null],
    );
    if (!result.rows[0]) throw new NotFoundError('Access token not found');
    await this.audit(principal, 'access_token.update', 'access_token', tokenId,
      (result.rows[0] as { libraryId: string | null }).libraryId);
    return result.rows[0];
  }

  async revokeAccessToken(principal: Principal, tokenId: string) {
    this.assertTenantAccess(principal);
    const result = await this.database.query<{ id: string; libraryId: string | null }>(
      `UPDATE api_keys SET revoked_at=NOW()
        WHERE tenant_id=$1 AND id=$2 AND revoked_at IS NULL
        RETURNING id,library_id AS "libraryId"`,
      [principal.tenantId, tokenId],
    );
    if (!result.rows[0]) throw new NotFoundError('Access token not found');
    await this.audit(principal, 'access_token.revoke', 'access_token', tokenId,
      result.rows[0].libraryId);
    return { id: tokenId, revoked: true };
  }

  async listAudit(principal: Principal, raw: z.infer<typeof AuditQuerySchema>) {
    const input = AuditQuerySchema.parse(raw);
    const requestedLibrary = principal.libraryId ?? input.libraryId ?? null;
    if (principal.libraryId && input.libraryId && principal.libraryId !== input.libraryId) {
      throw new NotFoundError('Library not found');
    }
    const parameters: unknown[] = [principal.tenantId, requestedLibrary];
    const conditions = ['tenant_id=$1', '($2::uuid IS NULL OR library_id=$2)'];
    if (input.action) conditions.push(`action=$${parameters.push(input.action)}`);
    if (input.resourceType) conditions.push(`resource_type=$${parameters.push(input.resourceType)}`);
    if (input.cursor) {
      const [date, id] = decodeCursor(input.cursor);
      const dateIndex = parameters.push(date);
      const idIndex = parameters.push(id);
      conditions.push(`(created_at,id) < ($${dateIndex}::timestamptz,$${idIndex}::uuid)`);
    }
    const limitIndex = parameters.push(input.limit + 1);
    const result = await this.database.query<{
      id: string; createdAt: Date;
    } & Record<string, unknown>>(
      `SELECT id,library_id AS "libraryId",api_key_id AS "apiKeyId",action,
              resource_type AS "resourceType",resource_id AS "resourceId",outcome,
              details,created_at AS "createdAt"
         FROM audit_log WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC,id DESC LIMIT $${limitIndex}`,
      parameters,
    );
    const hasMore = result.rows.length > input.limit;
    const items = result.rows.slice(0, input.limit);
    return { items, hasMore, nextCursor: hasMore && items.length
      ? encodeCursor(items[items.length - 1]!.createdAt, items[items.length - 1]!.id)
      : null };
  }

  async getSettings(principal: Principal) {
    this.assertTenantAccess(principal);
    const result = await this.database.query<{ settings: unknown }>(
      'SELECT settings FROM tenants WHERE id=$1 AND is_active=true',
      [principal.tenantId],
    );
    if (!result.rows[0]) throw new NotFoundError('Local workspace not found');
    return publicLocalSettings(result.rows[0].settings);
  }

  async updateSettings(principal: Principal, raw: LocalSettingsUpdate) {
    this.assertTenantAccess(principal);
    const input = LocalSettingsUpdateSchema.parse(raw);
    if (input.defaultLibraryId) await this.libraryRecord(principal, input.defaultLibraryId);
    const result = await this.database.query<{ settings: unknown }>(
      `UPDATE tenants SET settings = settings || $2::jsonb
        WHERE id=$1 AND is_active=true RETURNING settings`,
      [principal.tenantId, JSON.stringify(input)],
    );
    if (!result.rows[0]) throw new NotFoundError('Local workspace not found');
    await this.audit(principal, 'settings.update', 'tenant', principal.tenantId, null, {
      fields: Object.keys(input),
    });
    return publicLocalSettings(result.rows[0].settings);
  }

  async uploadBlob(
    principal: Principal,
    contentId: string,
    raw: z.infer<typeof BlobUploadSchema>,
  ) {
    const input = BlobUploadSchema.parse(raw);
    const scope = await this.contentScope(principal);
    const contentParameter = scope.parameters.push(contentId);
    const content = await this.database.query(
      `SELECT c.id FROM content_items c
        WHERE c.tenant_id=$1 AND c.id=$${contentParameter} AND c.status <> 'deleted'
          AND ${scope.membership}`,
      scope.parameters,
    );
    if (!content.rows[0]) throw new NotFoundError('Content not found');
    const data = Buffer.from(input.dataBase64, 'base64');
    if (data.byteLength === 0) throw new ConflictError('Blob data is empty');
    const stored = await this.storage.write({ tenantId: principal.tenantId, contentId, data });
    const result = await (async () => {
      try {
        return await this.database.query(
          `INSERT INTO content_blobs (
             tenant_id,content_id,storage_key,file_name,media_type,byte_size,sha256,source_metadata
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id,content_id AS "contentId",file_name AS "fileName",media_type AS "mediaType",
                     byte_size::integer AS "byteSize",sha256,source_metadata AS "sourceMetadata",
                     created_at AS "createdAt"`,
          [principal.tenantId, contentId, stored.storageKey, input.fileName, input.mediaType,
            stored.byteSize, stored.sha256, input.sourceMetadata],
        );
      } catch (error) {
        try {
          await this.storage.remove(stored.storageKey);
        } catch (cleanupError) {
          logger.warn('Failed to remove an uncommitted local blob', {
            storageKey: stored.storageKey,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
        throw error;
      }
    })();
    const blob = result.rows[0] as { id: string };
    await this.audit(principal, 'blob.upload', 'content_blob', blob.id,
      principal.libraryId ?? null, { contentId, byteSize: stored.byteSize });
    return blob;
  }

  async listBlobs(principal: Principal, contentId: string) {
    const scope = await this.contentScope(principal);
    const contentParameter = scope.parameters.push(contentId);
    const result = await this.database.query(
      `SELECT b.id,b.content_id AS "contentId",b.file_name AS "fileName",
              b.media_type AS "mediaType",b.byte_size::integer AS "byteSize",b.sha256,
              b.source_metadata AS "sourceMetadata",b.created_at AS "createdAt"
         FROM content_blobs b
         JOIN content_items c ON c.tenant_id=b.tenant_id AND c.id=b.content_id
        WHERE b.tenant_id=$1 AND b.content_id=$${contentParameter} AND c.status <> 'deleted'
          AND ${scope.membership}
        ORDER BY b.created_at DESC,b.id DESC`,
      scope.parameters,
    );
    return result.rows;
  }

  async downloadBlob(principal: Principal, blobId: string) {
    const scope = await this.contentScope(principal);
    const blobParameter = scope.parameters.push(blobId);
    const result = await this.database.query<{
      storage_key: string; file_name: string; media_type: string;
    }>(
      `SELECT b.storage_key,b.file_name,b.media_type
         FROM content_blobs b
         JOIN content_items c ON c.tenant_id=b.tenant_id AND c.id=b.content_id
        WHERE b.tenant_id=$1 AND b.id=$${blobParameter} AND c.status <> 'deleted'
          AND ${scope.membership}`,
      scope.parameters,
    );
    const blob = result.rows[0];
    if (!blob) throw new NotFoundError('Blob not found');
    const data = await this.storage.read(blob.storage_key);
    await this.audit(principal, 'blob.download', 'content_blob', blobId, principal.libraryId ?? null);
    return { data, fileName: blob.file_name, mediaType: blob.media_type };
  }
}
