CREATE TABLE organization_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'applied', 'undone')),
  proposal_mode TEXT NOT NULL CHECK (proposal_mode IN ('local', 'model')),
  sample_limit INTEGER NOT NULL CHECK (sample_limit BETWEEN 1 AND 50),
  sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
  source_snapshot_sha256 TEXT NOT NULL CHECK (source_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  proposal_sha256 TEXT NOT NULL CHECK (proposal_sha256 ~ '^[a-f0-9]{64}$'),
  suggestions JSONB NOT NULL CHECK (jsonb_typeof(suggestions) = 'array'),
  decisions JSONB CHECK (decisions IS NULL OR jsonb_typeof(decisions) = 'array'),
  apply_result JSONB CHECK (apply_result IS NULL OR jsonb_typeof(apply_result) = 'array'),
  model_provider TEXT,
  model_id TEXT,
  created_by UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  applied_by UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  undone_by UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  applied_at TIMESTAMPTZ,
  undone_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, source_snapshot_sha256, proposal_sha256)
);

CREATE INDEX organization_plans_tenant_created_idx
  ON organization_plans (tenant_id, created_at DESC, id DESC);

CREATE TRIGGER organization_plans_set_updated_at
  BEFORE UPDATE ON organization_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE organization_plans IS
  'Tenant-scoped preview, decision, apply, and undo evidence for local memory organization.';
