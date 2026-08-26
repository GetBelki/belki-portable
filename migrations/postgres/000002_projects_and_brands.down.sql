DROP TABLE IF EXISTS project_tracking_sources;
DROP TABLE IF EXISTS tracked_brands;
DROP INDEX IF EXISTS projects_active_workspace_idx;
ALTER TABLE projects
  DROP COLUMN IF EXISTS entity_auto_track_enabled,
  DROP COLUMN IF EXISTS entity_extraction_enabled,
  DROP COLUMN IF EXISTS product_enrichment_enabled,
  DROP COLUMN IF EXISTS html_retention_days,
  DROP COLUMN IF EXISTS raw_retention_days,
  DROP COLUMN IF EXISTS archived_at;
