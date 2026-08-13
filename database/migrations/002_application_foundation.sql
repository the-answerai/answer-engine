-- Neutral single-user application data model (#8).
-- The 001 baseline remains immutable. Every relation introduced here keeps a
-- tenant_id component in its keys and foreign keys.

ALTER TABLE libraries
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'user_defined',
  ADD COLUMN filter_predicate JSONB,
  ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN created_by TEXT;

ALTER TABLE libraries
  ADD CONSTRAINT libraries_kind_check
    CHECK (kind IN ('system_all_content', 'user_defined')),
  ADD CONSTRAINT libraries_system_filter_check
    CHECK (kind = 'user_defined' OR filter_predicate IS NULL);

UPDATE libraries
SET kind = 'system_all_content', filter_predicate = NULL
WHERE slug = 'personal-memory';

CREATE UNIQUE INDEX libraries_one_system_all_content_idx
  ON libraries (tenant_id) WHERE kind = 'system_all_content';
CREATE INDEX libraries_filter_predicate_idx
  ON libraries USING GIN (filter_predicate jsonb_path_ops);

ALTER TABLE tags
  ADD COLUMN parent_id UUID,
  ADD COLUMN color TEXT,
  ADD CONSTRAINT tags_parent_fk FOREIGN KEY (tenant_id, parent_id)
    REFERENCES tags(tenant_id, id) ON DELETE SET NULL,
  ADD CONSTRAINT tags_not_self_parent CHECK (parent_id IS NULL OR parent_id <> id),
  ADD CONSTRAINT tags_color_check CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$');

CREATE INDEX tags_parent_idx ON tags (tenant_id, parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE library_manual_includes (
  tenant_id UUID NOT NULL,
  library_id UUID NOT NULL,
  content_id UUID NOT NULL,
  added_by TEXT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, library_id, content_id),
  FOREIGN KEY (tenant_id, library_id)
    REFERENCES libraries(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, content_id)
    REFERENCES content_items(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE library_manual_excludes (
  tenant_id UUID NOT NULL,
  library_id UUID NOT NULL,
  content_id UUID NOT NULL,
  added_by TEXT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, library_id, content_id),
  FOREIGN KEY (tenant_id, library_id)
    REFERENCES libraries(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, content_id)
    REFERENCES content_items(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX library_manual_includes_content_idx
  ON library_manual_includes (tenant_id, content_id, library_id);
CREATE INDEX library_manual_excludes_content_idx
  ON library_manual_excludes (tenant_id, content_id, library_id);

CREATE TABLE content_blobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  content_id UUID NOT NULL,
  storage_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, storage_key),
  FOREIGN KEY (tenant_id, content_id)
    REFERENCES content_items(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX content_blobs_content_idx ON content_blobs (tenant_id, content_id, created_at DESC);

CREATE TABLE library_recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  library_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  content_types TEXT[] NOT NULL,
  system_prompt TEXT NOT NULL,
  user_prompt_template TEXT NOT NULL,
  output_type TEXT NOT NULL,
  output_schema JSONB,
  model_id TEXT,
  max_tokens INTEGER CHECK (max_tokens IS NULL OR max_tokens > 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version > 0),
  prompt_hash TEXT NOT NULL CHECK (prompt_hash ~ '^[a-f0-9]{64}$'),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, library_id, name),
  FOREIGN KEY (tenant_id, library_id)
    REFERENCES libraries(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT library_recipes_content_types_check CHECK (
    cardinality(content_types) > 0
    AND content_types <@ ARRAY['call','document','ticket','domain','chat','page']::text[]
  )
);
CREATE INDEX library_recipes_library_idx
  ON library_recipes (tenant_id, library_id, is_active, created_at DESC);
CREATE TRIGGER library_recipes_set_updated_at
  BEFORE UPDATE ON library_recipes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE library_recipe_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  recipe_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  content_types TEXT[] NOT NULL CHECK (cardinality(content_types) > 0),
  system_prompt TEXT NOT NULL,
  user_prompt_template TEXT NOT NULL,
  output_type TEXT NOT NULL,
  output_schema JSONB,
  model_id TEXT,
  max_tokens INTEGER,
  prompt_hash TEXT NOT NULL CHECK (prompt_hash ~ '^[a-f0-9]{64}$'),
  saved_by TEXT,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, recipe_id, version),
  FOREIGN KEY (tenant_id, recipe_id)
    REFERENCES library_recipes(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX library_recipe_versions_recipe_idx
  ON library_recipe_versions (tenant_id, recipe_id, version DESC);

CREATE TABLE library_recipe_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  library_id UUID NOT NULL,
  recipe_id UUID NOT NULL,
  recipe_version INTEGER NOT NULL CHECK (recipe_version > 0),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','partial_success','failed','canceled')),
  total_count INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  succeeded_count INTEGER NOT NULL DEFAULT 0 CHECK (succeeded_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  requested_by TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, library_id)
    REFERENCES libraries(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, recipe_id)
    REFERENCES library_recipes(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX library_recipe_runs_queue_idx
  ON library_recipe_runs (tenant_id, status, created_at) WHERE status IN ('queued','running');
CREATE INDEX library_recipe_runs_library_idx
  ON library_recipe_runs (tenant_id, library_id, created_at DESC, id DESC);
CREATE TRIGGER library_recipe_runs_set_updated_at
  BEFORE UPDATE ON library_recipe_runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE library_recipe_run_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  run_id UUID NOT NULL,
  content_id UUID NOT NULL,
  artifact_id UUID,
  status TEXT NOT NULL CHECK (status IN ('success','already_processed','skipped','error')),
  output_preview TEXT,
  output_data JSONB,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, run_id, content_id),
  FOREIGN KEY (tenant_id, run_id)
    REFERENCES library_recipe_runs(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, content_id)
    REFERENCES content_items(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, artifact_id)
    REFERENCES content_artifacts(tenant_id, id) ON DELETE SET NULL
);
CREATE INDEX library_recipe_run_items_run_idx
  ON library_recipe_run_items (tenant_id, run_id, created_at, id);

DROP INDEX content_artifacts_current_idx;
ALTER TABLE content_artifacts
  DROP CONSTRAINT content_artifacts_artifact_type_check,
  ADD CONSTRAINT content_artifacts_artifact_type_check
    CHECK (artifact_type ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'),
  ADD COLUMN recipe_id UUID,
  ADD COLUMN recipe_run_id UUID,
  ADD COLUMN created_by TEXT,
  ADD CONSTRAINT content_artifacts_recipe_fk FOREIGN KEY (tenant_id, recipe_id)
    REFERENCES library_recipes(tenant_id, id) ON DELETE SET NULL,
  ADD CONSTRAINT content_artifacts_recipe_run_fk FOREIGN KEY (tenant_id, recipe_run_id)
    REFERENCES library_recipe_runs(tenant_id, id) ON DELETE SET NULL;
CREATE UNIQUE INDEX content_artifacts_current_base_idx
  ON content_artifacts (tenant_id, content_id, artifact_type)
  WHERE is_current AND recipe_id IS NULL;
CREATE UNIQUE INDEX content_artifacts_current_recipe_idx
  ON content_artifacts (tenant_id, content_id, artifact_type, recipe_id)
  WHERE is_current AND recipe_id IS NOT NULL;
CREATE INDEX content_artifacts_recipe_idx
  ON content_artifacts (tenant_id, recipe_id, created_at DESC) WHERE recipe_id IS NOT NULL;

CREATE TABLE library_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  library_id UUID NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  prompt TEXT NOT NULL,
  schedule TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, library_id, slug),
  FOREIGN KEY (tenant_id, library_id)
    REFERENCES libraries(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX library_reports_library_idx ON library_reports (tenant_id, library_id, created_at DESC);
CREATE TRIGGER library_reports_set_updated_at
  BEFORE UPDATE ON library_reports FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE generated_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  library_id UUID NOT NULL,
  report_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','canceled')),
  title TEXT NOT NULL,
  body TEXT,
  source_content_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
  model_id TEXT,
  error_message TEXT,
  requested_by TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, library_id)
    REFERENCES libraries(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, report_id)
    REFERENCES library_reports(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX generated_reports_queue_idx
  ON generated_reports (tenant_id, status, created_at) WHERE status IN ('queued','running');
CREATE INDEX generated_reports_report_idx ON generated_reports (tenant_id, report_id, created_at DESC);
CREATE TRIGGER generated_reports_set_updated_at
  BEFORE UPDATE ON generated_reports FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE dashboards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  library_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  layout JSONB NOT NULL DEFAULT '[]'::jsonb,
  widgets JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, library_id, name),
  FOREIGN KEY (tenant_id, library_id)
    REFERENCES libraries(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX dashboards_library_idx ON dashboards (tenant_id, library_id, created_at DESC);
CREATE TRIGGER dashboards_set_updated_at
  BEFORE UPDATE ON dashboards FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE batch_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  library_id UUID,
  kind TEXT NOT NULL CHECK (kind IN ('prompt','export','import')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','partial_success','failed','canceled')),
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_count INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  succeeded_count INTEGER NOT NULL DEFAULT 0 CHECK (succeeded_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  requested_by TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, library_id)
    REFERENCES libraries(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX batch_jobs_queue_idx ON batch_jobs (tenant_id, status, created_at) WHERE status IN ('queued','running');
CREATE INDEX batch_jobs_list_idx ON batch_jobs (tenant_id, created_at DESC, id DESC);
CREATE TRIGGER batch_jobs_set_updated_at
  BEFORE UPDATE ON batch_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE batch_job_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  job_id UUID NOT NULL,
  content_id UUID,
  status TEXT NOT NULL CHECK (status IN ('success','skipped','error')),
  output JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, job_id, content_id),
  FOREIGN KEY (tenant_id, job_id)
    REFERENCES batch_jobs(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, content_id)
    REFERENCES content_items(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX batch_job_results_job_idx ON batch_job_results (tenant_id, job_id, created_at, id);

ALTER TABLE api_keys
  ADD COLUMN description TEXT,
  ADD COLUMN capabilities JSONB NOT NULL DEFAULT '["read","write"]'::jsonb,
  ADD CONSTRAINT api_keys_capabilities_array_check CHECK (jsonb_typeof(capabilities) = 'array'),
  ADD CONSTRAINT api_keys_tenant_id_id_unique UNIQUE (tenant_id, id);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  library_id UUID,
  api_key_id UUID,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  outcome TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','failure')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, library_id)
    REFERENCES libraries(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, api_key_id)
    REFERENCES api_keys(tenant_id, id) ON DELETE SET NULL (api_key_id)
);
CREATE INDEX audit_log_tenant_cursor_idx ON audit_log (tenant_id, created_at DESC, id DESC);
CREATE INDEX audit_log_library_cursor_idx ON audit_log (tenant_id, library_id, created_at DESC, id DESC);

COMMENT ON TABLE library_manual_includes IS
  'Manual membership additions; an exclude for the same item always wins.';
COMMENT ON TABLE content_blobs IS
  'Traversal-safe local blob metadata. Bytes are stored beneath AE_HOME by storage_key.';
COMMENT ON TABLE audit_log IS
  'Local tenant-scoped application history; no hosted identity or paid policy semantics.';
