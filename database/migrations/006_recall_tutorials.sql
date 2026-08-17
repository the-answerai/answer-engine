CREATE TABLE recall_tutorials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','remembered','verified')),
  write_client TEXT NOT NULL,
  recall_client TEXT NOT NULL,
  marker TEXT NOT NULL CHECK (marker ~ '^ae-demo-[a-f0-9]{12}$'),
  fact TEXT NOT NULL CHECK (char_length(fact) BETWEEN 1 AND 500),
  source_identifier TEXT NOT NULL,
  content_id UUID,
  diagnostic_code TEXT NOT NULL DEFAULT 'waiting_for_remember',
  diagnostic_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  remembered_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,marker),
  UNIQUE (tenant_id,source_identifier),
  FOREIGN KEY (tenant_id,content_id) REFERENCES content_items(tenant_id,id)
);

CREATE INDEX recall_tutorials_tenant_created_idx
  ON recall_tutorials (tenant_id,created_at DESC,id DESC);

CREATE TRIGGER recall_tutorials_set_updated_at
  BEFORE UPDATE ON recall_tutorials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE recall_tutorials IS
  'Tenant-scoped harmless remember/recall/lineage challenges with tool-audit evidence.';
