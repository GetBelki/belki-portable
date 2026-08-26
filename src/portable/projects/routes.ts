import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { QueryResultRow } from "pg";
import { z } from "zod";
import {
  BrandInputSchema,
  ProjectFeatureSettingsSchema,
  ProjectInputSchema,
  ProjectTrackingSourcesSchema,
  ProjectUpdateSchema,
  WorkspaceUpdateSchema,
} from "../../shared/contracts";
import { TRACKING_SOURCES, type TrackingSource } from "../../shared/tracking-sources";
import { normalizeHostname } from "../../worker/lib/domain";
import { requireRole, type PortableAppEnv } from "../auth/middleware";
import { ApiError } from "../http";
import type { PortableRuntime } from "../runtime";
import { PostgresUsageRepository } from "../usage/repository";
import { listProjects } from "./repository";

const IdParamSchema = z.object({ id: z.string().uuid() });
const ProjectIdParamSchema = z.object({ projectId: z.string().uuid() });

interface ProjectRow extends QueryResultRow {
  id: string;
  name: string;
  primary_domain: string | null;
  html_capture_enabled: boolean;
  product_enrichment_enabled: boolean;
  entity_extraction_enabled: boolean;
  entity_auto_track_enabled: boolean;
  raw_retention_days: number;
  html_retention_days: number;
  archived_at: Date | null;
}

export function createProjectRoutes(runtime: PortableRuntime): Hono<PortableAppEnv> {
  const routes = new Hono<PortableAppEnv>();
  const usage = new PostgresUsageRepository(runtime.database);

  routes.patch(
    "/settings/workspace",
    zValidator("json", WorkspaceUpdateSchema),
    async (context) => {
      const principal = requireRole(context, "owner");
      const input = context.req.valid("json");
      if (input.publicBaseUrl && input.publicBaseUrl !== runtime.config.APP_BASE_URL) {
        throw new ApiError(
          409,
          "public_origin_managed",
          "The public application URL is managed by this deployment.",
        );
      }
      const result = await runtime.database.query<{
        id: string;
        name: string;
        public_base_url: string;
      } & QueryResultRow>(
        `UPDATE workspaces SET name = COALESCE($1, name),
          public_base_url = COALESCE($2, public_base_url), updated_at = now()
         WHERE id = $3
         RETURNING id, name, public_base_url`,
        [input.name ?? null, input.publicBaseUrl ?? null, principal.workspaceId],
      );
      const workspace = result.rows[0];
      if (!workspace) throw new ApiError(404, "workspace_not_found", "Workspace not found.");
      await audit(runtime, principal, "workspace.updated", "workspace", principal.workspaceId, input);
      return context.json({
        data: {
          id: workspace.id,
          name: workspace.name,
          publicBaseUrl: runtime.config.APP_BASE_URL,
        },
      });
    },
  );

  routes.get("/settings/health", (context) => {
    requireRole(context, "admin");
    return context.json({
      data: {
        provider: {
          dataForSeo: {
            configured: Boolean(
              runtime.config.DATAFORSEO_LOGIN && runtime.config.DATAFORSEO_PASSWORD,
            ),
            source: "environment",
            account: runtime.config.DATAFORSEO_LOGIN ?? "not configured",
          },
          stripe: {
            configured: runtime.config.PAYMENT_MODE !== "disabled",
            mode: runtime.config.PAYMENT_MODE,
            source: "environment",
          },
          email: {
            configured: runtime.email.configured,
            source: runtime.config.EMAIL_MODE,
          },
        },
        publicOrigin: {
          configured: runtime.config.APP_BASE_URL,
          stored: runtime.config.APP_BASE_URL,
        },
      },
    });
  });

  routes.get("/projects", async (context) => {
    const principal = context.get("principal");
    return context.json({ data: await listProjects(runtime.database, principal.workspaceId) });
  });

  routes.get("/projects/archived", async (context) => {
    const principal = requireRole(context, "admin");
    const result = await runtime.database.query(
      `SELECT id, name, primary_domain, archived_at
       FROM projects WHERE workspace_id = $1 AND deleted_at IS NULL
         AND archived_at IS NOT NULL
       ORDER BY archived_at DESC`,
      [principal.workspaceId],
    );
    return context.json({ data: result.rows });
  });

  routes.patch(
    "/projects/:id/restore",
    zValidator("param", IdParamSchema),
    async (context) => {
      const principal = requireRole(context, "admin");
      const { id } = context.req.valid("param");
      const archived = await runtime.database.query(
        `SELECT id FROM projects WHERE id = $1 AND workspace_id = $2
         AND deleted_at IS NULL AND archived_at IS NOT NULL`,
        [id, principal.workspaceId],
      );
      if (archived.rowCount === 0) {
        throw new ApiError(404, "archived_project_not_found", "Archived project not found.");
      }
      const claimId = crypto.randomUUID();
      await usage.claimProject(principal.workspaceId, claimId, id);
      try {
        const restored = await runtime.database.query(
          `UPDATE projects SET archived_at = NULL, updated_at = now()
           WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
             AND archived_at IS NOT NULL`,
          [id, principal.workspaceId],
        );
        if (restored.rowCount !== 1) {
          throw new ApiError(409, "project_already_restored", "This project is already active.");
        }
      } catch (error) {
        await usage.releaseResourceClaim(principal.workspaceId, claimId);
        throw error;
      }
      await audit(runtime, principal, "project.restored", "project", id);
      return context.json({ data: { id, restored: true } });
    },
  );

  routes.post("/projects", zValidator("json", ProjectInputSchema), async (context) => {
    const principal = requireRole(context, "editor");
    const input = context.req.valid("json");
    const projectId = crypto.randomUUID();
    const primaryDomain = normalizeHostname(input.primaryDomain).registrableDomain;
    await usage.claimProject(principal.workspaceId, projectId, projectId);
    try {
      await runtime.database.transaction(async (transaction) => {
        await transaction.query(
          `INSERT INTO projects (
            id, workspace_id, name, primary_domain, html_capture_enabled,
            created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, now(), now())`,
          [
            projectId,
            principal.workspaceId,
            input.name,
            primaryDomain,
            input.htmlCaptureEnabled,
          ],
        );
        await transaction.query(
          `INSERT INTO project_tracking_sources (project_id, source, enabled)
           VALUES ($1, 'chatgpt', true)`,
          [projectId],
        );
        await transaction.query(
          `INSERT INTO tracked_brands (id, project_id, kind, name, aliases, domains)
           VALUES ($1, $2, 'owned', $3, $4::jsonb, $5::jsonb)`,
          [
            crypto.randomUUID(),
            projectId,
            input.ownedBrandName,
            JSON.stringify(input.ownedBrandAliases),
            JSON.stringify(primaryDomain ? [primaryDomain] : []),
          ],
        );
        for (const competitor of input.competitorBrands) {
          const domains = normalizedDomains(competitor.domains);
          await transaction.query(
            `INSERT INTO tracked_brands (id, project_id, kind, name, aliases, domains)
             VALUES ($1, $2, 'competitor', $3, $4::jsonb, $5::jsonb)`,
            [
              crypto.randomUUID(),
              projectId,
              competitor.name,
              JSON.stringify(competitor.aliases),
              JSON.stringify(domains),
            ],
          );
        }
      });
    } catch (error) {
      await usage.releaseResourceClaim(principal.workspaceId, projectId);
      throw error;
    }
    await audit(runtime, principal, "project.created", "project", projectId);
    return context.json({ data: { id: projectId } }, 201);
  });

  routes.get("/projects/:id", zValidator("param", IdParamSchema), async (context) => {
    const principal = context.get("principal");
    const { id } = context.req.valid("param");
    const project = await requireProject(runtime, principal.workspaceId, id);
    const brands = await runtime.database.query<{
      id: string;
      kind: "owned" | "competitor";
      name: string;
      aliases: string[];
      domains: string[];
      created_at: Date;
      updated_at: Date;
    } & QueryResultRow>(
      `SELECT id, kind, name, aliases, domains, created_at, updated_at
       FROM tracked_brands WHERE project_id = $1
       ORDER BY kind DESC, lower(name), id`,
      [id],
    );
    return context.json({ data: { project, brands: brands.rows } });
  });

  routes.get(
    "/projects/:id/settings",
    zValidator("param", IdParamSchema),
    async (context) => {
      const principal = context.get("principal");
      const { id } = context.req.valid("param");
      const project = await requireProject(runtime, principal.workspaceId, id);
      const sources = await runtime.database.query<{ source: TrackingSource } & QueryResultRow>(
        `SELECT source FROM project_tracking_sources
         WHERE project_id = $1 AND enabled = true
         ORDER BY array_position(ARRAY[
           'chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview'
         ]::text[], source)`,
        [id],
      );
      return context.json({
        data: {
          id: project.id,
          name: project.name,
          primaryDomain: project.primary_domain,
          htmlCaptureEnabled: project.html_capture_enabled,
          productEnrichmentEnabled: project.product_enrichment_enabled,
          entityExtractionEnabled: project.entity_extraction_enabled,
          entityAutoTrackEnabled: project.entity_auto_track_enabled,
          rawRetentionDays: project.raw_retention_days,
          htmlRetentionDays: project.html_retention_days,
          trackingSources: sources.rows.map((row) => row.source),
          availableTrackingSources: [...TRACKING_SOURCES],
          allowedTrackingSources: [...TRACKING_SOURCES],
          trackingSourceLimit: 4,
        },
      });
    },
  );

  routes.patch(
    "/projects/:id/tracking-sources",
    zValidator("param", IdParamSchema),
    zValidator("json", ProjectTrackingSourcesSchema),
    async (context) => {
      const principal = requireRole(context, "admin");
      const { id } = context.req.valid("param");
      const { sources } = context.req.valid("json");
      await requireProject(runtime, principal.workspaceId, id);
      await runtime.database.transaction(async (transaction) => {
        for (const source of TRACKING_SOURCES) {
          await transaction.query(
            `INSERT INTO project_tracking_sources (project_id, source, enabled, updated_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (project_id, source) DO UPDATE SET
               enabled = excluded.enabled, updated_at = excluded.updated_at`,
            [id, source, sources.includes(source)],
          );
        }
      });
      await audit(
        runtime,
        principal,
        "project.tracking_sources_updated",
        "project",
        id,
        { sources },
      );
      return context.json({ data: { id, trackingSources: sources } });
    },
  );

  routes.patch(
    "/projects/:id/settings",
    zValidator("param", IdParamSchema),
    zValidator("json", ProjectFeatureSettingsSchema),
    async (context) => {
      const principal = requireRole(context, "admin");
      const { id } = context.req.valid("param");
      const input = context.req.valid("json");
      const current = await requireProject(runtime, principal.workspaceId, id);
      const entityExtractionEnabled =
        input.entityExtractionEnabled ?? current.entity_extraction_enabled;
      const entityAutoTrackEnabled = entityExtractionEnabled
        ? input.entityAutoTrackEnabled ?? current.entity_auto_track_enabled
        : false;
      const result = await runtime.database.query<ProjectRow>(
        `UPDATE projects SET
          html_capture_enabled = $1,
          product_enrichment_enabled = $2,
          entity_extraction_enabled = $3,
          entity_auto_track_enabled = $4,
          updated_at = now()
         WHERE id = $5
         RETURNING *`,
        [
          input.htmlCaptureEnabled ?? current.html_capture_enabled,
          input.productEnrichmentEnabled ?? current.product_enrichment_enabled,
          entityExtractionEnabled,
          entityAutoTrackEnabled,
          id,
        ],
      );
      const updated = result.rows[0];
      if (!updated) throw new ApiError(404, "project_not_found", "Project not found.");
      await audit(runtime, principal, "project.features_updated", "project", id, input);
      return context.json({
        data: {
          id,
          htmlCaptureEnabled: updated.html_capture_enabled,
          productEnrichmentEnabled: updated.product_enrichment_enabled,
          entityExtractionEnabled: updated.entity_extraction_enabled,
          entityAutoTrackEnabled: updated.entity_auto_track_enabled,
        },
      });
    },
  );

  routes.patch(
    "/projects/:id",
    zValidator("param", IdParamSchema),
    zValidator("json", ProjectUpdateSchema),
    async (context) => {
      const principal = requireRole(context, "editor");
      const { id } = context.req.valid("param");
      const input = context.req.valid("json");
      const current = await requireProject(runtime, principal.workspaceId, id);
      const primaryDomain = input.primaryDomain === undefined
        ? current.primary_domain
        : normalizeHostname(input.primaryDomain).registrableDomain;
      await runtime.database.query(
        `UPDATE projects SET name = $1, primary_domain = $2,
          html_capture_enabled = $3, updated_at = now()
         WHERE id = $4`,
        [
          input.name ?? current.name,
          primaryDomain,
          input.htmlCaptureEnabled ?? current.html_capture_enabled,
          id,
        ],
      );
      await audit(runtime, principal, "project.updated", "project", id);
      return context.json({ data: { id } });
    },
  );

  routes.post(
    "/projects/:projectId/brands",
    zValidator("param", ProjectIdParamSchema),
    zValidator("json", BrandInputSchema),
    async (context) => {
      const principal = requireRole(context, "editor");
      const { projectId } = context.req.valid("param");
      const input = context.req.valid("json");
      await requireProject(runtime, principal.workspaceId, projectId);
      const id = crypto.randomUUID();
      await runtime.database.query(
        `INSERT INTO tracked_brands (id, project_id, kind, name, aliases, domains)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [
          id,
          projectId,
          input.kind,
          input.name,
          JSON.stringify(input.aliases),
          JSON.stringify(normalizedDomains(input.domains)),
        ],
      );
      return context.json({ data: { id } }, 201);
    },
  );

  routes.patch(
    "/brands/:id",
    zValidator("param", IdParamSchema),
    zValidator("json", BrandInputSchema.partial()),
    async (context) => {
      const principal = requireRole(context, "editor");
      const { id } = context.req.valid("param");
      const input = context.req.valid("json");
      const current = await runtime.database.query<{
        kind: "owned" | "competitor";
        name: string;
        aliases: string[];
        domains: string[];
      } & QueryResultRow>(
        `SELECT brand.kind, brand.name, brand.aliases, brand.domains
         FROM tracked_brands brand
         JOIN projects project ON project.id = brand.project_id
         WHERE brand.id = $1 AND project.workspace_id = $2
           AND project.deleted_at IS NULL`,
        [id, principal.workspaceId],
      );
      const brand = current.rows[0];
      if (!brand) throw new ApiError(404, "brand_not_found", "Tracked brand not found.");
      await runtime.database.query(
        `UPDATE tracked_brands SET kind = $1, name = $2, aliases = $3::jsonb,
          domains = $4::jsonb, updated_at = now() WHERE id = $5`,
        [
          input.kind ?? brand.kind,
          input.name ?? brand.name,
          JSON.stringify(input.aliases ?? brand.aliases),
          JSON.stringify(input.domains ? normalizedDomains(input.domains) : brand.domains),
          id,
        ],
      );
      return context.json({ data: { id } });
    },
  );

  routes.delete("/brands/:id", zValidator("param", IdParamSchema), async (context) => {
    const principal = requireRole(context, "editor");
    const { id } = context.req.valid("param");
    const result = await runtime.database.query(
      `DELETE FROM tracked_brands brand USING projects project
       WHERE brand.id = $1 AND project.id = brand.project_id
         AND project.workspace_id = $2 AND project.deleted_at IS NULL`,
      [id, principal.workspaceId],
    );
    if (result.rowCount === 0) {
      throw new ApiError(404, "brand_not_found", "Tracked brand not found.");
    }
    return context.json({ data: { deleted: true } });
  });

  routes.delete("/projects/:id", zValidator("param", IdParamSchema), async (context) => {
    const principal = requireRole(context, "admin");
    const { id } = context.req.valid("param");
    await requireProject(runtime, principal.workspaceId, id);
    const prompts = await runtime.database.query<{ id: string } & QueryResultRow>(
      `SELECT id FROM tracked_queries
       WHERE project_id = $1 AND deleted_at IS NULL AND is_active = true`,
      [id],
    );
    await runtime.database.transaction(async (transaction) => {
      await transaction.query(
        "UPDATE projects SET deleted_at = now(), updated_at = now() WHERE id = $1",
        [id],
      );
      await transaction.query(
        `UPDATE tracked_queries SET deleted_at = now(), is_active = false, updated_at = now()
         WHERE project_id = $1 AND deleted_at IS NULL`,
        [id],
      );
    });
    await usage.releaseResources(principal.workspaceId, "project", [id]);
    await usage.releaseResources(
      principal.workspaceId,
      "prompt",
      prompts.rows.map((prompt) => prompt.id),
    );
    await audit(runtime, principal, "project.deletion_requested", "project", id);
    return context.json({ data: { deleted: true } });
  });

  return routes;
}

async function requireProject(
  runtime: PortableRuntime,
  workspaceId: string,
  projectId: string,
): Promise<ProjectRow> {
  const result = await runtime.database.query<ProjectRow>(
    `SELECT id, name, primary_domain, html_capture_enabled,
      product_enrichment_enabled, entity_extraction_enabled,
      entity_auto_track_enabled, raw_retention_days, html_retention_days, archived_at
     FROM projects WHERE id = $1 AND workspace_id = $2
       AND deleted_at IS NULL AND archived_at IS NULL`,
    [projectId, workspaceId],
  );
  const project = result.rows[0];
  if (!project) throw new ApiError(404, "project_not_found", "Project not found.");
  return project;
}

function normalizedDomains(domains: readonly string[]): string[] {
  return [...new Set(domains
    .map((domain) => normalizeHostname(domain).registrableDomain)
    .filter((domain): domain is string => Boolean(domain)))];
}

async function audit(
  runtime: PortableRuntime,
  principal: { workspaceId: string; userId: string },
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: unknown = {},
): Promise<void> {
  await runtime.database.query(
    `INSERT INTO audit_log (
      id, workspace_id, user_id, action, resource_type, resource_id, metadata, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())`,
    [
      crypto.randomUUID(),
      principal.workspaceId,
      principal.userId,
      action,
      resourceType,
      resourceId,
      JSON.stringify(metadata),
    ],
  );
}
