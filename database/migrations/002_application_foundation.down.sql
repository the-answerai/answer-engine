-- Roll back the neutral application foundation while retaining all 001 data.

DROP TABLE IF EXISTS audit_log;

ALTER TABLE api_keys
  DROP CONSTRAINT IF EXISTS api_keys_capabilities_array_check,
  DROP COLUMN IF EXISTS capabilities,
  DROP COLUMN IF EXISTS description;

DROP TABLE IF EXISTS batch_job_results;
DROP TABLE IF EXISTS batch_jobs;
DROP TABLE IF EXISTS dashboards;
DROP TABLE IF EXISTS generated_reports;
DROP TABLE IF EXISTS library_reports;

DROP INDEX IF EXISTS content_artifacts_recipe_idx;
DROP INDEX IF EXISTS content_artifacts_current_recipe_idx;
DROP INDEX IF EXISTS content_artifacts_current_base_idx;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, content_id, artifact_type
           ORDER BY version DESC, created_at DESC, id DESC
         ) AS position
  FROM content_artifacts
  WHERE is_current
)
UPDATE content_artifacts artifact
SET is_current = false, status = 'superseded'
FROM ranked
WHERE artifact.id = ranked.id AND ranked.position > 1;

ALTER TABLE content_artifacts
  DROP CONSTRAINT IF EXISTS content_artifacts_artifact_type_check,
  ADD CONSTRAINT content_artifacts_artifact_type_check CHECK (
    artifact_type IN (
      'raw_text', 'cleaned_text', 'domain_report', 'extraction_json',
      'generated_field', 'analysis_variant'
    )
  ),
  DROP CONSTRAINT IF EXISTS content_artifacts_recipe_run_fk,
  DROP CONSTRAINT IF EXISTS content_artifacts_recipe_fk,
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS recipe_run_id,
  DROP COLUMN IF EXISTS recipe_id;

CREATE UNIQUE INDEX content_artifacts_current_idx
  ON content_artifacts (tenant_id, content_id, artifact_type)
  WHERE is_current;

DROP TABLE IF EXISTS library_recipe_run_items;
DROP TABLE IF EXISTS library_recipe_runs;
DROP TABLE IF EXISTS library_recipe_versions;
DROP TABLE IF EXISTS library_recipes;
DROP TABLE IF EXISTS content_blobs;
DROP TABLE IF EXISTS library_manual_excludes;
DROP TABLE IF EXISTS library_manual_includes;

ALTER TABLE tags
  DROP CONSTRAINT IF EXISTS tags_color_check,
  DROP CONSTRAINT IF EXISTS tags_not_self_parent,
  DROP CONSTRAINT IF EXISTS tags_parent_fk,
  DROP COLUMN IF EXISTS color,
  DROP COLUMN IF EXISTS parent_id;

DROP INDEX IF EXISTS libraries_filter_predicate_idx;
DROP INDEX IF EXISTS libraries_one_system_all_content_idx;
ALTER TABLE libraries
  DROP CONSTRAINT IF EXISTS libraries_system_filter_check,
  DROP CONSTRAINT IF EXISTS libraries_kind_check,
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS metadata,
  DROP COLUMN IF EXISTS filter_predicate,
  DROP COLUMN IF EXISTS kind;
