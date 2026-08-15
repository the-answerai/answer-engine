-- Preview-first, explicitly approved local-folder ingestion.

CREATE TABLE folder_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  library_id UUID,
  root_path TEXT NOT NULL,
  include_patterns TEXT[] NOT NULL DEFAULT ARRAY['**/*.md','**/*.markdown','**/*.txt']::text[],
  exclude_patterns TEXT[] NOT NULL DEFAULT '{}'::text[],
  max_file_bytes BIGINT NOT NULL CHECK (max_file_bytes > 0),
  max_total_bytes BIGINT NOT NULL CHECK (max_total_bytes > 0),
  symlink_policy TEXT NOT NULL DEFAULT 'no_follow' CHECK (symlink_policy = 'no_follow'),
  manifest_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN (
    'previewed','approved','active','paused','removal_pending','removed'
  )),
  retention TEXT CHECK (retention IS NULL OR retention IN ('keep','delete')),
  approved_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, root_path),
  FOREIGN KEY (tenant_id, library_id) REFERENCES libraries(tenant_id, id) ON DELETE SET NULL (library_id),
  CHECK (status IN ('previewed','removal_pending','removed') OR approved_at IS NOT NULL),
  CHECK (status <> 'removed' OR (removed_at IS NOT NULL AND retention IS NOT NULL))
);
CREATE INDEX folder_sources_tenant_status_idx
  ON folder_sources (tenant_id, status, created_at DESC, id DESC);
CREATE TRIGGER folder_sources_set_updated_at
  BEFORE UPDATE ON folder_sources FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE folder_ingestion_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  source_id UUID NOT NULL,
  kind TEXT NOT NULL DEFAULT 'initial' CHECK (kind IN ('initial','refresh','removal')),
  status TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN (
    'previewed','approved','running','cancel_requested','canceled','completed','failed'
  )),
  manifest_path TEXT NOT NULL,
  inventory_counts JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(inventory_counts) = 'object'),
  approved_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, source_id) REFERENCES folder_sources(tenant_id, id) ON DELETE CASCADE,
  CHECK (status IN ('previewed','canceled') OR approved_at IS NOT NULL)
);
CREATE INDEX folder_ingestion_runs_source_idx
  ON folder_ingestion_runs (tenant_id, source_id, created_at DESC, id DESC);
CREATE TRIGGER folder_ingestion_runs_set_updated_at
  BEFORE UPDATE ON folder_ingestion_runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE folder_ingestion_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  run_id UUID NOT NULL,
  source_id UUID NOT NULL,
  source_path TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  file_type TEXT,
  byte_size BIGINT NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  modified_at TIMESTAMPTZ,
  disposition TEXT NOT NULL CHECK (disposition IN (
    'candidate','excluded','hidden','unsupported','binary','too_large',
    'access_denied','symlink','aggregate_limit','missing'
  )),
  reason TEXT NOT NULL,
  change_kind TEXT CHECK (change_kind IS NULL OR change_kind IN ('added','changed','unchanged','missing','excluded')),
  metadata_fingerprint TEXT CHECK (metadata_fingerprint IS NULL OR metadata_fingerprint ~ '^[a-f0-9]{64}$'),
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN (
    'pending','imported','updated','duplicate','excluded','changed','failed','skipped','missing'
  )),
  applied_sha256 TEXT CHECK (applied_sha256 IS NULL OR applied_sha256 ~ '^[a-f0-9]{64}$'),
  content_id UUID,
  archive_manifest_path TEXT,
  error_code TEXT,
  recovery_action TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, run_id, relative_path),
  FOREIGN KEY (tenant_id, run_id) REFERENCES folder_ingestion_runs(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, source_id) REFERENCES folder_sources(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, content_id) REFERENCES content_items(tenant_id, id) ON DELETE SET NULL (content_id),
  CHECK (disposition = 'candidate' OR outcome <> 'pending'),
  CHECK (outcome NOT IN ('imported','updated') OR (
    applied_sha256 IS NOT NULL AND content_id IS NOT NULL AND archive_manifest_path IS NOT NULL
  )),
  CHECK (outcome <> 'failed' OR (error_code IS NOT NULL AND recovery_action IS NOT NULL))
);
CREATE INDEX folder_ingestion_items_progress_idx
  ON folder_ingestion_items (tenant_id, run_id, outcome, relative_path);
CREATE INDEX folder_ingestion_items_content_idx
  ON folder_ingestion_items (tenant_id, source_id, content_id) WHERE content_id IS NOT NULL;
CREATE TRIGGER folder_ingestion_items_set_updated_at
  BEFORE UPDATE ON folder_ingestion_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE folder_sources IS
  'User-selected local roots and immutable safety policy; no source exists without a metadata-only preview.';
COMMENT ON TABLE folder_ingestion_items IS
  'Complete preview and applied inventory, including safely reported exclusions and SHA-256 lineage.';
