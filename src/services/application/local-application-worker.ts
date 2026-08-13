import { z } from 'zod';
import type { Database } from '../../config/database.js';
import type { LanguageProvider } from '../ai/openai-compatible.js';
import { LibraryFilterSchema, buildEffectiveMembership } from '../library/library-membership.js';
import { logger } from '../../utils/logger.js';
import { parseRecipeOutput, recipeResponseFormat } from './application-schemas.js';

interface RecipeClaim {
  id: string;
  tenant_id: string;
  library_id: string;
  recipe_id: string;
  recipe_version: number;
}

interface ReportClaim {
  id: string;
  tenant_id: string;
  library_id: string;
  report_id: string;
}

interface BatchClaim {
  id: string;
  tenant_id: string;
  library_id: string | null;
  kind: 'prompt' | 'export' | 'import';
  input: unknown;
}

interface RecipeDetails {
  name: string;
  content_types: string[];
  system_prompt: string;
  user_prompt_template: string;
  output_type: string;
  output_schema: Record<string, unknown> | null;
  model_id: string | null;
  max_tokens: number | null;
  prompt_hash: string;
  filter_predicate: unknown;
}

function filter(value: unknown) {
  return value == null ? null : LibraryFilterSchema.parse(value);
}

export class LocalApplicationWorker {
  constructor(
    private readonly database: Database,
    private readonly language: LanguageProvider,
  ) {}

  async runNext(): Promise<'recipe' | 'report' | 'batch' | null> {
    const recipe = await this.claimRecipe();
    if (recipe) {
      await this.processRecipe(recipe);
      return 'recipe';
    }
    const report = await this.claimReport();
    if (report) {
      await this.processReport(report);
      return 'report';
    }
    const batch = await this.claimBatch();
    if (batch) {
      await this.processBatch(batch);
      return 'batch';
    }
    return null;
  }

  private async claimRecipe(): Promise<RecipeClaim | null> {
    const result = await this.database.query<RecipeClaim>(
      `UPDATE library_recipe_runs SET status='running',started_at=COALESCE(started_at,NOW())
        WHERE id=(
          SELECT id FROM library_recipe_runs WHERE status='queued'
          ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
        )
        RETURNING id,tenant_id,library_id,recipe_id,recipe_version`,
    );
    return result.rows[0] ?? null;
  }

  private async processRecipe(run: RecipeClaim): Promise<void> {
    try {
      const details = await this.database.query<RecipeDetails>(
        `SELECT r.name,v.content_types,v.system_prompt,v.user_prompt_template,
                v.output_type,v.output_schema,v.model_id,v.max_tokens,v.prompt_hash,
                l.filter_predicate
           FROM library_recipes r
           JOIN library_recipe_versions v
             ON v.tenant_id=r.tenant_id AND v.recipe_id=r.id AND v.version=$4
           JOIN libraries l ON l.tenant_id=r.tenant_id AND l.id=r.library_id
          WHERE r.tenant_id=$1 AND r.id=$2 AND r.library_id=$3`,
        [run.tenant_id, run.recipe_id, run.library_id, run.recipe_version],
      );
      const recipe = details.rows[0];
      if (!recipe) throw new Error('Recipe or requested recipe version is missing');
      const parameters: unknown[] = [run.tenant_id, run.library_id];
      const membership = buildEffectiveMembership({
        contentAlias: 'c', tenantParameter: 1, libraryParameter: 2,
        filter: filter(recipe.filter_predicate), parameters,
      });
      const typesIndex = parameters.push(recipe.content_types);
      const content = await this.database.query<{
        id: string; title: string; content: string | null; summary: string | null;
      }>(
        `SELECT c.id,c.title,c.content,c.summary FROM content_items c
          WHERE c.tenant_id=$1 AND c.status='active' AND ${membership}
            AND c.content_type=ANY($${typesIndex}::text[])
          ORDER BY c.created_at,c.id`,
        parameters,
      );
      await this.database.query(
        `UPDATE library_recipe_runs SET total_count=$3 WHERE tenant_id=$1 AND id=$2`,
        [run.tenant_id, run.id, content.rows.length],
      );
      for (const item of content.rows) {
        const state = await this.database.query<{ status: string }>(
          `SELECT status FROM library_recipe_runs WHERE tenant_id=$1 AND id=$2`,
          [run.tenant_id, run.id],
        );
        if (state.rows[0]?.status === 'canceled') return;
        try {
          const completion = await this.language.complete({
            system: recipe.system_prompt,
            prompt: recipe.user_prompt_template.replace('{{content}}', item.content ?? item.summary ?? ''),
            model: recipe.model_id ?? undefined,
            maxTokens: recipe.max_tokens ?? undefined,
            responseFormat: recipeResponseFormat(recipe.output_schema),
          });
          const afterCompletion = await this.database.query<{ status: string }>(
            `SELECT status FROM library_recipe_runs WHERE tenant_id=$1 AND id=$2`,
            [run.tenant_id, run.id],
          );
          if (afterCompletion.rows[0]?.status === 'canceled') return;
          await this.recordRecipeSuccess(run, recipe, item, completion);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.database.query(
            `INSERT INTO library_recipe_run_items (
               tenant_id,run_id,content_id,status,error_message,started_at,completed_at
             ) VALUES ($1,$2,$3,'error',$4,NOW(),NOW())
             ON CONFLICT (tenant_id,run_id,content_id) DO UPDATE SET
               status='error',error_message=EXCLUDED.error_message,completed_at=NOW()`,
            [run.tenant_id, run.id, item.id, message],
          );
        }
        await this.refreshRecipeCounts(run);
      }
      const counts = await this.refreshRecipeCounts(run);
      const status = counts.failed > 0
        ? (counts.succeeded > 0 ? 'partial_success' : 'failed')
        : 'succeeded';
      await this.database.query(
        `UPDATE library_recipe_runs SET status=$3,completed_at=NOW()
          WHERE tenant_id=$1 AND id=$2 AND status='running'`,
        [run.tenant_id, run.id, status],
      );
    } catch (error) {
      await this.fail('library_recipe_runs', run.tenant_id, run.id, error);
    }
  }

  private async recordRecipeSuccess(
    run: RecipeClaim,
    recipe: RecipeDetails,
    item: { id: string; title: string },
    completion: { text: string; model: string; provider: string },
  ): Promise<void> {
    const outputData = parseRecipeOutput(completion.text, recipe.output_schema);
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{ id: string; version: number }>(
        `SELECT id,version FROM content_artifacts
          WHERE tenant_id=$1 AND content_id=$2 AND artifact_type=$3
            AND recipe_id=$4 AND is_current=true FOR UPDATE`,
        [run.tenant_id, item.id, recipe.output_type, run.recipe_id],
      );
      if (current.rows[0]) {
        await client.query(
          `UPDATE content_artifacts SET is_current=false,status='superseded'
            WHERE tenant_id=$1 AND id=$2`,
          [run.tenant_id, current.rows[0].id],
        );
      }
      const artifact = await client.query<{ id: string }>(
        `INSERT INTO content_artifacts (
           tenant_id,content_id,artifact_type,text_content,data_json,source_content_ids,
           recipe_id,recipe_run_id,recipe_version,prompt_hash,model_id,status,
           supersedes_id,version,is_current,metadata,started_at,completed_at
         ) VALUES ($1,$2,$3,$4,$5,ARRAY[$2]::uuid[],$6,$7,$8,$9,$10,'success',
                   $11,$12,true,$13,NOW(),NOW()) RETURNING id`,
        [run.tenant_id, item.id, recipe.output_type, completion.text, outputData ?? null,
          run.recipe_id, run.id, String(run.recipe_version), recipe.prompt_hash, completion.model,
          current.rows[0]?.id ?? null, (current.rows[0]?.version ?? 0) + 1,
          { provider: completion.provider, recipeName: recipe.name }],
      );
      await client.query(
        `INSERT INTO library_recipe_run_items (
           tenant_id,run_id,content_id,artifact_id,status,output_preview,output_data,
           started_at,completed_at
         ) VALUES ($1,$2,$3,$4,'success',$5,$6,NOW(),NOW())
         ON CONFLICT (tenant_id,run_id,content_id) DO UPDATE SET
           artifact_id=EXCLUDED.artifact_id,status='success',output_preview=EXCLUDED.output_preview,
           output_data=EXCLUDED.output_data,error_message=NULL,completed_at=NOW()`,
        [run.tenant_id, run.id, item.id, artifact.rows[0]!.id,
          completion.text.slice(0, 1_000), outputData ?? null],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async refreshRecipeCounts(run: RecipeClaim): Promise<{ succeeded: number; failed: number }> {
    const result = await this.database.query<{ succeeded: string; failed: string; processed: string }>(
      `SELECT COUNT(*) FILTER (WHERE status='success')::text AS succeeded,
              COUNT(*) FILTER (WHERE status='error')::text AS failed,
              COUNT(*)::text AS processed
         FROM library_recipe_run_items WHERE tenant_id=$1 AND run_id=$2`,
      [run.tenant_id, run.id],
    );
    const succeeded = Number(result.rows[0]?.succeeded ?? 0);
    const failed = Number(result.rows[0]?.failed ?? 0);
    await this.database.query(
      `UPDATE library_recipe_runs SET processed_count=$3,succeeded_count=$4,failed_count=$5
        WHERE tenant_id=$1 AND id=$2`,
      [run.tenant_id, run.id, Number(result.rows[0]?.processed ?? 0), succeeded, failed],
    );
    return { succeeded, failed };
  }

  private async claimReport(): Promise<ReportClaim | null> {
    const result = await this.database.query<ReportClaim>(
      `UPDATE generated_reports SET status='running',started_at=COALESCE(started_at,NOW())
        WHERE id=(
          SELECT id FROM generated_reports WHERE status='queued'
          ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
        ) RETURNING id,tenant_id,library_id,report_id`,
    );
    return result.rows[0] ?? null;
  }

  private async processReport(job: ReportClaim): Promise<void> {
    try {
      const report = await this.database.query<{
        title: string; prompt: string; filter_predicate: unknown;
      }>(
        `SELECT r.title,r.prompt,l.filter_predicate FROM library_reports r
         JOIN libraries l ON l.tenant_id=r.tenant_id AND l.id=r.library_id
         WHERE r.tenant_id=$1 AND r.id=$2 AND r.library_id=$3`,
        [job.tenant_id, job.report_id, job.library_id],
      );
      const definition = report.rows[0];
      if (!definition) throw new Error('Report definition is missing');
      const parameters: unknown[] = [job.tenant_id, job.library_id];
      const membership = buildEffectiveMembership({
        contentAlias: 'c', tenantParameter: 1, libraryParameter: 2,
        filter: filter(definition.filter_predicate), parameters,
      });
      const sources = await this.database.query<{ id: string; title: string; text: string }>(
        `SELECT c.id,c.title,COALESCE(c.content,c.summary,'') AS text FROM content_items c
          WHERE c.tenant_id=$1 AND c.status='active' AND ${membership}
          ORDER BY c.created_at DESC,c.id DESC LIMIT 50`,
        parameters,
      );
      const context = sources.rows.map((row, index) => `[${index + 1}] ${row.title}\n${row.text.slice(0, 2_000)}`).join('\n\n');
      const completion = await this.language.complete({
        system: 'Write a grounded local report using only the supplied evidence. Cite evidence as [1], [2].',
        prompt: `${definition.prompt}\n\nEvidence:\n${context}`,
      });
      await this.database.query(
        `UPDATE generated_reports SET status='succeeded',body=$3,source_content_ids=$4,
                model_id=$5,completed_at=NOW()
          WHERE tenant_id=$1 AND id=$2 AND status='running'`,
        [job.tenant_id, job.id, completion.text, sources.rows.map((row) => row.id), completion.model],
      );
    } catch (error) {
      await this.fail('generated_reports', job.tenant_id, job.id, error);
    }
  }

  private async claimBatch(): Promise<BatchClaim | null> {
    const result = await this.database.query<BatchClaim>(
      `UPDATE batch_jobs SET status='running',started_at=COALESCE(started_at,NOW())
        WHERE id=(
          SELECT id FROM batch_jobs WHERE status='queued'
          ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
        ) RETURNING id,tenant_id,library_id,kind,input`,
    );
    return result.rows[0] ?? null;
  }

  private async processBatch(job: BatchClaim): Promise<void> {
    try {
      const input = z.record(z.unknown()).parse(job.input);
      const ids = z.array(z.string().uuid()).max(10_000).optional().parse(input.contentIds);
      const excludedIds = z.array(z.string().uuid()).max(10_000).catch([])
        .parse(input.excludeContentIds);
      const parameters: unknown[] = [job.tenant_id];
      let membership = 'TRUE';
      if (job.library_id) {
        const libraryParameter = parameters.push(job.library_id);
        const library = await this.database.query<{ filter_predicate: unknown }>(
          `SELECT filter_predicate FROM libraries WHERE tenant_id=$1 AND id=$2 AND is_active=true`,
          [job.tenant_id, job.library_id],
        );
        if (!library.rows[0]) throw new Error('Batch library is missing');
        membership = buildEffectiveMembership({
          contentAlias: 'c', tenantParameter: 1, libraryParameter,
          filter: filter(library.rows[0].filter_predicate), parameters,
        });
      }
      const selected = ids
        ? `AND c.id=ANY($${parameters.push(ids)}::uuid[])`
        : '';
      const excluded = excludedIds.length
        ? `AND NOT (c.id=ANY($${parameters.push(excludedIds)}::uuid[]))`
        : '';
      const content = await this.database.query<{
        id: string; title: string; content: string | null; summary: string | null;
      }>(
        `SELECT c.id,c.title,c.content,c.summary FROM content_items c
          WHERE c.tenant_id=$1 AND c.status <> 'deleted'
            ${selected} ${excluded} AND ${membership}
          ORDER BY c.created_at,c.id`,
        parameters,
      );
      const resolvedContentIds = content.rows.map((item) => item.id);
      await this.database.query(
        `UPDATE batch_jobs SET total_count=$3,
                input=jsonb_set(input,'{contentIds}',to_jsonb($4::uuid[]),true)
          WHERE tenant_id=$1 AND id=$2`,
        [job.tenant_id, job.id, resolvedContentIds.length, resolvedContentIds],
      );
      for (const item of content.rows) {
        const state = await this.database.query<{ status: string }>(
          `SELECT status FROM batch_jobs WHERE tenant_id=$1 AND id=$2`,
          [job.tenant_id, job.id],
        );
        if (state.rows[0]?.status === 'canceled') return;
        try {
          let output: Record<string, unknown>;
          if (job.kind === 'prompt') {
            const prompt = z.string().min(1).parse(input.prompt);
            const completion = await this.language.complete({
              system: z.string().default('Analyze the supplied local content.').parse(input.systemPrompt),
              prompt: `${prompt}\n\n${item.content ?? item.summary ?? ''}`,
            });
            output = { text: completion.text, modelId: completion.model, provider: completion.provider };
          } else {
            output = { title: item.title, content: item.content, summary: item.summary };
          }
          await this.database.query(
            `INSERT INTO batch_job_results (tenant_id,job_id,content_id,status,output)
             VALUES ($1,$2,$3,'success',$4)
             ON CONFLICT (tenant_id,job_id,content_id) DO UPDATE SET
               status='success',output=EXCLUDED.output,error_message=NULL`,
            [job.tenant_id, job.id, item.id, output],
          );
        } catch (error) {
          await this.database.query(
            `INSERT INTO batch_job_results (tenant_id,job_id,content_id,status,error_message)
             VALUES ($1,$2,$3,'error',$4)
             ON CONFLICT (tenant_id,job_id,content_id) DO UPDATE SET
               status='error',error_message=EXCLUDED.error_message`,
            [job.tenant_id, job.id, item.id, error instanceof Error ? error.message : String(error)],
          );
        }
      }
      const counts = await this.database.query<{ succeeded: string; failed: string }>(
        `SELECT COUNT(*) FILTER (WHERE status='success')::text AS succeeded,
                COUNT(*) FILTER (WHERE status='error')::text AS failed
           FROM batch_job_results WHERE tenant_id=$1 AND job_id=$2`,
        [job.tenant_id, job.id],
      );
      const succeeded = Number(counts.rows[0]?.succeeded ?? 0);
      const failed = Number(counts.rows[0]?.failed ?? 0);
      const status = failed ? (succeeded ? 'partial_success' : 'failed') : 'succeeded';
      await this.database.query(
        `UPDATE batch_jobs SET status=$3,processed_count=$4,succeeded_count=$5,
                failed_count=$6,completed_at=NOW()
          WHERE tenant_id=$1 AND id=$2 AND status='running'`,
        [job.tenant_id, job.id, status, succeeded + failed, succeeded, failed],
      );
    } catch (error) {
      await this.fail('batch_jobs', job.tenant_id, job.id, error);
    }
  }

  private async fail(table: 'library_recipe_runs' | 'generated_reports' | 'batch_jobs', tenantId: string, id: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await this.database.query(
      `UPDATE ${table} SET status='failed',error_message=$3,completed_at=NOW()
        WHERE tenant_id=$1 AND id=$2 AND status <> 'canceled'`,
      [tenantId, id, message.slice(0, 4_000)],
    );
    logger.error('Local application job failed', { table, id, error: message });
  }
}

export function startLocalApplicationWorker(
  worker: LocalApplicationWorker,
  pollMilliseconds: number,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await worker.runNext();
    } catch (error) {
      logger.error('Local application worker poll failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, pollMilliseconds);
  void tick();
  return () => clearInterval(timer);
}
