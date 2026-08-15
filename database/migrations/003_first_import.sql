-- Consent-first, resumable import lifecycle for local source-backed workflows.

CREATE TABLE first_import_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'discovered' CHECK (status IN (
    'discovered','approved','running','cancel_requested','canceled','completed','failed'
  )),
  manifest_path TEXT NOT NULL,
  selected_source_ids TEXT[] NOT NULL DEFAULT '{}'::text[],
  approved_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id),
  CHECK ((approved_at IS NULL) = (cardinality(selected_source_ids) = 0))
);
CREATE INDEX first_import_sessions_latest_idx
  ON first_import_sessions (tenant_id, created_at DESC, id DESC);
CREATE TRIGGER first_import_sessions_set_updated_at
  BEFORE UPDATE ON first_import_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE first_import_sources (
  tenant_id UUID NOT NULL,
  session_id UUID NOT NULL,
  source_id TEXT NOT NULL CHECK (source_id IN ('claude-code','codex','cowork')),
  label TEXT NOT NULL,
  paths JSONB NOT NULL CHECK (jsonb_typeof(paths) = 'array'),
  estimated_count INTEGER NOT NULL CHECK (estimated_count >= 0),
  estimated_bytes BIGINT NOT NULL CHECK (estimated_bytes >= 0),
  privacy_posture TEXT NOT NULL,
  exclusions JSONB NOT NULL CHECK (jsonb_typeof(exclusions) = 'array'),
  availability TEXT NOT NULL CHECK (availability IN ('available','not_found','unsupported_platform','unavailable')),
  availability_note TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'discovered' CHECK (status IN (
    'discovered','approved','running','completed','failed','skipped','canceled'
  )),
  error_code TEXT,
  recovery_action TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, session_id, source_id),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES first_import_sessions(tenant_id, id) ON DELETE CASCADE
);
CREATE TRIGGER first_import_sources_set_updated_at
  BEFORE UPDATE ON first_import_sources FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE first_import_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  session_id UUID NOT NULL,
  source_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  source_path TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
  modified_at TIMESTAMPTZ NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN (
    'pending','imported','duplicate','failed','skipped'
  )),
  content_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
  archive_manifest_path TEXT,
  error_code TEXT,
  recovery_action TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, session_id, source_id, fingerprint),
  FOREIGN KEY (tenant_id, session_id, source_id)
    REFERENCES first_import_sources(tenant_id, session_id, source_id) ON DELETE CASCADE,
  CHECK (
    outcome <> 'imported'
    OR (cardinality(content_ids) > 0 AND archive_manifest_path IS NOT NULL)
  ),
  CHECK (outcome <> 'failed' OR (error_code IS NOT NULL AND recovery_action IS NOT NULL))
);
CREATE INDEX first_import_items_progress_idx
  ON first_import_items (tenant_id, session_id, source_id, outcome);
CREATE TRIGGER first_import_items_set_updated_at
  BEFORE UPDATE ON first_import_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE first_import_sessions IS
  'Tenant-scoped consent and reconciliation lifecycle reusable by source-backed imports.';
COMMENT ON TABLE first_import_items IS
  'Metadata-only discovery inventory and durable per-source outcome manifest; transcript bodies are never stored here.';
