ALTER TABLE projects
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN raw_retention_days integer NOT NULL DEFAULT 730 CHECK (raw_retention_days >= 1),
  ADD COLUMN html_retention_days integer NOT NULL DEFAULT 90 CHECK (html_retention_days >= 1),
  ADD COLUMN product_enrichment_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN entity_extraction_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN entity_auto_track_enabled boolean NOT NULL DEFAULT false;

CREATE INDEX projects_active_workspace_idx
  ON projects (workspace_id, updated_at DESC)
  WHERE deleted_at IS NULL AND archived_at IS NULL;

CREATE TABLE tracked_brands (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('owned', 'competitor')),
  name text NOT NULL,
  aliases jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(aliases) = 'array'),
  domains jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(domains) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tracked_brands_project_idx ON tracked_brands (project_id, kind, lower(name));

CREATE TABLE project_tracking_sources (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source text NOT NULL
    CHECK (source IN ('chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, source)
);
