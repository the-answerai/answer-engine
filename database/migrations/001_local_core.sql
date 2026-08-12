-- Answer Engine OSS 1.1.0 local-first baseline.
--
-- This file is intentionally a fresh baseline rather than a copy of the
-- enterprise migration history. EMBEDDING_DIMENSION is substituted by the
-- migration runner after strict integer validation.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE schema_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_settings (key, value)
VALUES ('embedding_dimension', '{{EMBEDDING_DIMENSION}}');

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  settings JSONB NOT NULL DEFAULT '{"no_training":true}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER tenants_set_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE libraries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, slug)
);

CREATE INDEX libraries_tenant_active_idx
  ON libraries (tenant_id, is_active, created_at DESC);

CREATE TRIGGER libraries_set_updated_at
  BEFORE UPDATE ON libraries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  library_id UUID,
  key_hash TEXT NOT NULL UNIQUE CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  key_prefix TEXT NOT NULL,
  name TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, library_id)
    REFERENCES libraries(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX api_keys_tenant_active_idx
  ON api_keys (tenant_id, created_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX api_keys_prefix_idx ON api_keys (key_prefix);

CREATE TRIGGER api_keys_set_updated_at
  BEFORE UPDATE ON api_keys
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE source_agents (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  label TEXT NOT NULL,
  provider TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO source_agents (id, label, provider)
VALUES
  ('claude', 'Claude Code and Cowork', 'anthropic'),
  ('cowork', 'Cowork', 'anthropic'),
  ('codex', 'Codex', 'openai'),
  ('local_dir', 'Local files', NULL);

CREATE TABLE content_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  library_id UUID NOT NULL,
  content_type TEXT NOT NULL CHECK (
    content_type IN ('call', 'document', 'ticket', 'domain', 'chat', 'page')
  ),
  source TEXT NOT NULL DEFAULT 'manual',
  source_identifier TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  summary TEXT,
  source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  analysis_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_archive_manifest JSONB,
  external_url TEXT,
  primary_text_kind TEXT CHECK (
    primary_text_kind IS NULL OR primary_text_kind IN (
      'raw_text', 'cleaned_text', 'domain_report', 'extraction_json',
      'generated_field', 'analysis_variant'
    )
  ),
  embedding vector({{EMBEDDING_DIMENSION}}),
  search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(content, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(summary, '')), 'C')
  ) STORED,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'deleted')),
  source_agent_id TEXT REFERENCES source_agents(id),
  conversation_id TEXT,
  turn_index INTEGER CHECK (turn_index IS NULL OR turn_index >= 0),
  turn_role TEXT CHECK (
    turn_role IS NULL OR turn_role IN (
      'user', 'assistant', 'system', 'tool', 'developer', 'other'
    )
  ),
  turn_timestamp TIMESTAMPTZ,
  turn_metadata JSONB,
  content_timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, content_type, source_identifier),
  FOREIGN KEY (tenant_id, library_id)
    REFERENCES libraries(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX content_items_tenant_list_idx
  ON content_items (tenant_id, status, created_at DESC, id DESC);

CREATE INDEX content_items_library_list_idx
  ON content_items (tenant_id, library_id, status, created_at DESC, id DESC);

CREATE INDEX content_items_search_idx ON content_items USING GIN (search_vector);

CREATE INDEX content_items_embedding_idx
  ON content_items USING hnsw (embedding vector_cosine_ops);

CREATE INDEX content_items_conversation_idx
  ON content_items (
    tenant_id, source_agent_id, conversation_id, turn_index, turn_timestamp
  )
  WHERE content_type = 'chat' AND conversation_id IS NOT NULL;

CREATE TRIGGER content_items_set_updated_at
  BEFORE UPDATE ON content_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  category TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, slug)
);

CREATE INDEX tags_tenant_active_idx ON tags (tenant_id, is_active, slug);

CREATE TRIGGER tags_set_updated_at
  BEFORE UPDATE ON tags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE content_tags (
  tenant_id UUID NOT NULL,
  content_id UUID NOT NULL,
  tag_id UUID NOT NULL,
  confidence NUMERIC CHECK (confidence BETWEEN 0 AND 1),
  applied_by TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, content_id, tag_id),
  FOREIGN KEY (tenant_id, content_id)
    REFERENCES content_items(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, tag_id)
    REFERENCES tags(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX content_tags_tag_idx ON content_tags (tenant_id, tag_id, content_id);

CREATE TABLE content_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  content_id UUID NOT NULL,
  artifact_type TEXT NOT NULL CHECK (
    artifact_type IN (
      'raw_text', 'cleaned_text', 'domain_report', 'extraction_json',
      'generated_field', 'analysis_variant'
    )
  ),
  text_content TEXT,
  data_json JSONB,
  source_content_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
  supersedes_id UUID,
  recipe_version TEXT,
  prompt_hash TEXT,
  model_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'success', 'no_content', 'error', 'superseded')
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  is_current BOOLEAN NOT NULL DEFAULT true,
  run_id TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, content_id)
    REFERENCES content_items(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, supersedes_id)
    REFERENCES content_artifacts(tenant_id, id)
);

CREATE UNIQUE INDEX content_artifacts_current_idx
  ON content_artifacts (tenant_id, content_id, artifact_type)
  WHERE is_current;

CREATE INDEX content_artifacts_versions_idx
  ON content_artifacts (tenant_id, content_id, artifact_type, version DESC);

CREATE INDEX content_artifacts_source_ids_idx
  ON content_artifacts USING GIN (source_content_ids);

CREATE TRIGGER content_artifacts_set_updated_at
  BEFORE UPDATE ON content_artifacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION hybrid_search(
  p_tenant_id UUID,
  p_query TEXT,
  p_embedding vector({{EMBEDDING_DIMENSION}}),
  p_library_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 20
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  content TEXT,
  summary TEXT,
  content_type TEXT,
  source TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ,
  keyword_score REAL,
  semantic_score REAL,
  combined_score REAL
) AS $$
  WITH keyword AS (
    SELECT
      c.id,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank(c.search_vector, plainto_tsquery('english', p_query)) DESC,
          c.id
      ) AS rank,
      ts_rank(c.search_vector, plainto_tsquery('english', p_query))::REAL AS score
    FROM content_items c
    WHERE c.tenant_id = p_tenant_id
      AND c.status = 'active'
      AND (p_library_id IS NULL OR c.library_id = p_library_id)
      AND c.search_vector @@ plainto_tsquery('english', p_query)
  ),
  semantic AS (
    SELECT
      c.id,
      ROW_NUMBER() OVER (ORDER BY c.embedding <=> p_embedding, c.id) AS rank,
      (1 - (c.embedding <=> p_embedding))::REAL AS score
    FROM content_items c
    WHERE c.tenant_id = p_tenant_id
      AND c.status = 'active'
      AND c.embedding IS NOT NULL
      AND (p_library_id IS NULL OR c.library_id = p_library_id)
  ),
  fused AS (
    SELECT
      COALESCE(k.id, s.id) AS id,
      COALESCE(k.score, 0)::REAL AS keyword_score,
      COALESCE(s.score, 0)::REAL AS semantic_score,
      (
        CASE WHEN k.rank IS NULL THEN 0 ELSE 0.5 / (60.0 + k.rank) END +
        CASE WHEN s.rank IS NULL THEN 0 ELSE 0.5 / (60.0 + s.rank) END
      )::REAL AS combined_score
    FROM keyword k
    FULL OUTER JOIN semantic s ON s.id = k.id
  )
  SELECT
    c.id, c.title, c.content, c.summary, c.content_type, c.source,
    c.metadata, c.created_at, f.keyword_score, f.semantic_score,
    f.combined_score
  FROM fused f
  JOIN content_items c ON c.tenant_id = p_tenant_id AND c.id = f.id
  ORDER BY f.combined_score DESC, c.id
  LIMIT LEAST(GREATEST(p_limit, 1), 100);
$$ LANGUAGE sql STABLE;

COMMENT ON TABLE tenants IS
  'Local data-isolation boundary for all persisted memory.';
COMMENT ON COLUMN content_items.raw_archive_manifest IS
  'Optional immutable raw-archive manifest or manifest reference for source provenance.';
COMMENT ON TABLE content_artifacts IS
  'Versioned derived artifacts with complete supersession and source-content lineage.';
