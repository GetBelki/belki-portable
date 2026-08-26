CREATE TABLE tracked_queries (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  query_text text NOT NULL CHECK (length(btrim(query_text)) BETWEEN 1 AND 2000),
  location_code integer NOT NULL,
  language_code text NOT NULL CHECK (length(language_code) BETWEEN 1 AND 20),
  force_web_search boolean NOT NULL DEFAULT true,
  schedule_cadence text NOT NULL CHECK (schedule_cadence IN ('daily', 'weekly')),
  schedule_time text NOT NULL CHECK (schedule_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  schedule_weekday integer CHECK (schedule_weekday BETWEEN 0 AND 6),
  schedule_timezone text NOT NULL,
  next_run_at timestamptz NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (
    (schedule_cadence = 'daily' AND schedule_weekday IS NULL)
    OR (schedule_cadence = 'weekly' AND schedule_weekday IS NOT NULL)
  )
);
CREATE INDEX tracked_queries_project_idx
  ON tracked_queries (project_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX tracked_queries_due_idx
  ON tracked_queries (next_run_at, id)
  WHERE deleted_at IS NULL AND is_active = true;
CREATE UNIQUE INDEX tracked_queries_active_text_idx
  ON tracked_queries (project_id, lower(btrim(query_text)))
  WHERE deleted_at IS NULL;

CREATE TABLE prompt_tags (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  normalized_name text NOT NULL,
  color_index integer NOT NULL CHECK (color_index BETWEEN 0 AND 7),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, normalized_name)
);
CREATE INDEX prompt_tags_project_idx ON prompt_tags (project_id, normalized_name);

CREATE TABLE tracked_query_tags (
  tracked_query_id uuid NOT NULL REFERENCES tracked_queries(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES prompt_tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tracked_query_id, tag_id)
);
CREATE INDEX tracked_query_tags_tag_idx
  ON tracked_query_tags (tag_id, tracked_query_id);
