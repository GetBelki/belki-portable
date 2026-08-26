import type { QueryResultRow } from "pg";
import type { Database } from "../contracts";

export interface ProjectSummary {
  id: string;
  name: string;
  primary_domain: string | null;
  html_capture_enabled: number;
  created_at: Date;
  updated_at: Date;
  query_count: number;
  last_snapshot_at: Date | null;
  ads_count: number;
  products_count: number;
  source_data_counts: Record<string, { ads: number; products: number }>;
}

interface ProjectSummaryRow extends QueryResultRow, Omit<ProjectSummary, "source_data_counts"> {}

export async function listProjects(
  database: Database,
  workspaceId: string,
): Promise<ProjectSummary[]> {
  const result = await database.query<ProjectSummaryRow>(
    `SELECT project.id, project.name, project.primary_domain,
      CASE WHEN project.html_capture_enabled THEN 1 ELSE 0 END AS html_capture_enabled,
      project.created_at, project.updated_at,
      (
        SELECT COUNT(*)::integer
        FROM tracked_queries query
        WHERE query.project_id = project.id AND query.deleted_at IS NULL
      ) AS query_count,
      NULL::timestamptz AS last_snapshot_at,
      0::integer AS ads_count,
      0::integer AS products_count
     FROM projects project
     WHERE project.workspace_id = $1 AND project.deleted_at IS NULL
       AND project.archived_at IS NULL
     ORDER BY project.updated_at DESC, project.id`,
    [workspaceId],
  );
  return result.rows.map((project) => ({ ...project, source_data_counts: {} }));
}
