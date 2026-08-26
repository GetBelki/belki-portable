import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { QueryResultRow } from "pg";
import { z } from "zod";
import {
  BulkQueryInputSchema,
  PromptTagMutationSchema,
  QueryInputSchema,
  QueryUpdateSchema,
  TrackingSourceSchema,
  type Schedule,
} from "../../shared/contracts";
import {
  MAX_PROMPT_TAGS,
  MAX_PROJECT_TAGS,
  promptTagColorIndex,
  promptTagKey,
  uniquePromptTagNames,
} from "../../shared/prompt-tags";
import { calculateNextRun } from "../../worker/lib/schedule";
import { requireRole, type PortableAppEnv } from "../auth/middleware";
import type { QueryExecutor } from "../contracts";
import { ApiError } from "../http";
import type { PortableRuntime } from "../runtime";
import { PostgresUsageRepository } from "../usage/repository";

const IdParamSchema = z.object({ id: z.string().uuid() });
const ProjectIdParamSchema = z.object({ projectId: z.string().uuid() });
const QueryListSchema = z.object({
  projectId: z.string().uuid().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const PromptTagIdsSchema = z.string().max(400).transform(
  (value) => [...new Set(value.split(",").filter(Boolean))],
).refine(
  (values) => values.length <= MAX_PROMPT_TAGS
    && values.every((value) => z.string().uuid().safeParse(value).success),
  "Tag filters must contain up to 10 valid tag IDs.",
);
const PromptAnalyticsSchema = z.object({
  projectId: z.string().uuid(),
  source: TrackingSourceSchema.default("chatgpt"),
  search: z.string().trim().max(200).optional(),
  locationCode: z.coerce.number().int().optional(),
  languageCode: z.string().trim().max(12).optional(),
  tagIds: PromptTagIdsSchema.optional(),
  cursor: z.string().max(4096).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const QueryStatusSchema = z.object({ isActive: z.boolean() });

interface QueryRow extends QueryResultRow {
  id: string;
  project_id: string;
  query_text: string;
  location_code: number;
  language_code: string;
  force_web_search: boolean;
  schedule_cadence: "daily" | "weekly";
  schedule_time: string;
  schedule_weekday: number | null;
  schedule_timezone: string;
  next_run_at: Date;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  project_name?: string;
}

interface TagRow extends QueryResultRow {
  id: string;
  name: string;
  normalized_name: string;
  color_index: number;
}

type QueryInput = z.infer<typeof QueryInputSchema>;

export function createQueryRoutes(runtime: PortableRuntime): Hono<PortableAppEnv> {
  const routes = new Hono<PortableAppEnv>();
  const usage = new PostgresUsageRepository(runtime.database);

  routes.get("/queries", zValidator("query", QueryListSchema), async (context) => {
    const principal = context.get("principal");
    const input = context.req.valid("query");
    const values: unknown[] = [principal.workspaceId];
    const clauses = [
      "project.workspace_id = $1",
      "project.deleted_at IS NULL",
      "project.archived_at IS NULL",
      "query.deleted_at IS NULL",
    ];
    if (input.projectId) {
      values.push(input.projectId);
      clauses.push(`query.project_id = $${values.length}`);
    }
    if (input.cursor) {
      values.push(input.cursor);
      clauses.push(`query.id > $${values.length}`);
    }
    values.push(input.limit + 1);
    const result = await runtime.database.query<QueryRow>(
      `SELECT query.*, project.name AS project_name,
        NULL::timestamptz AS last_snapshot_at,
        0::integer AS snapshot_count,
        NULL::text AS latest_run_status
       FROM tracked_queries query
       JOIN projects project ON project.id = query.project_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY query.id
       LIMIT $${values.length}`,
      values,
    );
    const rows = result.rows.slice(0, input.limit);
    return context.json({
      data: rows,
      page: {
        nextCursor: result.rows.length > input.limit ? rows.at(-1)?.id ?? null : null,
      },
    });
  });

  routes.get("/queries/:id", zValidator("param", IdParamSchema), async (context) => {
    const principal = context.get("principal");
    const { id } = context.req.valid("param");
    const result = await runtime.database.query<QueryRow>(
      `SELECT query.*, project.name AS project_name,
        NULL::timestamptz AS last_snapshot_at,
        0::integer AS snapshot_count,
        NULL::text AS latest_run_status
       FROM tracked_queries query
       JOIN projects project ON project.id = query.project_id
       WHERE query.id = $1 AND project.workspace_id = $2
         AND query.deleted_at IS NULL AND project.deleted_at IS NULL`,
      [id, principal.workspaceId],
    );
    const query = result.rows[0];
    if (!query) throw new ApiError(404, "query_not_found", "Tracked query not found.");
    return context.json({ data: query });
  });

  routes.post(
    "/projects/:projectId/queries/bulk",
    zValidator("param", ProjectIdParamSchema),
    zValidator("json", BulkQueryInputSchema),
    async (context) => {
      const principal = requireRole(context, "editor");
      const { projectId } = context.req.valid("param");
      const input = context.req.valid("json");
      await requireProject(runtime, principal.workspaceId, projectId);

      const requestedItems = input.items ?? (input.queryTexts ?? []).map((queryText) => ({
        queryText,
        tags: [] as string[],
      }));
      const uniquePrompts = new Map<string, { queryText: string; tags: string[] }>();
      for (const item of requestedItems) {
        const queryText = item.queryText.trim();
        const normalized = queryText.toLowerCase();
        const tags = uniquePromptTagNames([...input.tags, ...item.tags]);
        const current = uniquePrompts.get(normalized);
        if (current) current.tags = uniquePromptTagNames([...current.tags, ...tags]);
        else uniquePrompts.set(normalized, { queryText, tags });
      }

      const normalizedPrompts = [...uniquePrompts.keys()];
      const existing = await runtime.database.query<{
        id: string;
        query_text: string;
      } & QueryResultRow>(
        `SELECT id, query_text FROM tracked_queries
         WHERE project_id = $1 AND deleted_at IS NULL
           AND lower(btrim(query_text)) = ANY($2::text[])`,
        [projectId, normalizedPrompts],
      );
      const existingPrompts = new Map(
        existing.rows.map((row) => [row.query_text.trim().toLowerCase(), row.id]),
      );
      const records = [...uniquePrompts.entries()]
        .filter(([normalized]) => !existingPrompts.has(normalized))
        .map(([normalized, prompt]) => ({
          id: crypto.randomUUID(),
          normalized,
          ...prompt,
        }));
      const targets = [...uniquePrompts.entries()].map(([normalized, prompt]) => ({
        id: existingPrompts.get(normalized)
          ?? records.find((record) => record.normalized === normalized)!.id,
        tags: prompt.tags,
      }));
      const claimId = crypto.randomUUID();
      if (records.length > 0) {
        await usage.claimPrompts(
          principal.workspaceId,
          claimId,
          records.map((record) => record.id),
        );
      }
      try {
        await runtime.database.transaction(async (transaction) => {
          for (const record of records) {
            await insertQuery(transaction, record.id, projectId, record.queryText, input);
          }
          const tags = await resolveTags(
            transaction,
            projectId,
            uniquePromptTagNames(targets.flatMap((target) => target.tags)),
          );
          for (const target of targets) {
            await assignTags(transaction, target.id, target.tags, tags);
          }
        });
      } catch (error) {
        if (records.length > 0) {
          await usage.releaseResourceClaim(principal.workspaceId, claimId);
        }
        throw error;
      }
      await audit(runtime, principal, "query.bulk_created", "project", projectId, {
        createdCount: records.length,
        skippedCount: requestedItems.length - records.length,
      });
      return context.json({
        data: {
          ids: records.map((record) => record.id),
          createdCount: records.length,
          skippedCount: requestedItems.length - records.length,
        },
      }, 201);
    },
  );

  routes.post(
    "/projects/:projectId/queries",
    zValidator("param", ProjectIdParamSchema),
    zValidator("json", QueryInputSchema),
    async (context) => {
      const principal = requireRole(context, "editor");
      const { projectId } = context.req.valid("param");
      const input = context.req.valid("json");
      await requireProject(runtime, principal.workspaceId, projectId);
      const duplicate = await runtime.database.query(
        `SELECT 1 FROM tracked_queries WHERE project_id = $1 AND deleted_at IS NULL
         AND lower(btrim(query_text)) = lower(btrim($2))`,
        [projectId, input.queryText],
      );
      if (duplicate.rowCount !== 0) {
        throw new ApiError(409, "query_already_exists", "This prompt is already tracked.");
      }
      const id = crypto.randomUUID();
      const claimId = crypto.randomUUID();
      await usage.claimPrompts(principal.workspaceId, claimId, [id]);
      let nextRunAt: string;
      try {
        await runtime.database.transaction(async (transaction) => {
          nextRunAt = await insertQuery(transaction, id, projectId, input.queryText, input);
          const tags = await resolveTags(transaction, projectId, input.tags);
          await assignTags(transaction, id, input.tags, tags);
        });
      } catch (error) {
        await usage.releaseResourceClaim(principal.workspaceId, claimId);
        throw error;
      }
      await audit(runtime, principal, "query.created", "tracked_query", id, { projectId });
      return context.json({ data: { id, nextRunAt: nextRunAt! } }, 201);
    },
  );

  routes.patch(
    "/queries/:id",
    zValidator("param", IdParamSchema),
    zValidator("json", QueryUpdateSchema),
    async (context) => {
      const principal = requireRole(context, "editor");
      const { id } = context.req.valid("param");
      const input = context.req.valid("json");
      const current = await requireQuery(runtime, principal.workspaceId, id);
      const schedule = input.schedule ?? scheduleFromRow(current);
      const nextRunAt = input.schedule
        ? calculateNextRun(schedule)
        : current.next_run_at.toISOString();
      await runtime.database.query(
        `UPDATE tracked_queries SET query_text = $1, location_code = $2,
          language_code = $3, force_web_search = $4, schedule_cadence = $5,
          schedule_time = $6, schedule_weekday = $7, schedule_timezone = $8,
          next_run_at = $9, updated_at = now() WHERE id = $10`,
        [
          input.queryText ?? current.query_text,
          input.locationCode ?? current.location_code,
          input.languageCode ?? current.language_code,
          input.forceWebSearch ?? current.force_web_search,
          schedule.cadence,
          schedule.time,
          schedule.cadence === "weekly" ? schedule.weekday : null,
          schedule.timezone,
          nextRunAt,
          id,
        ],
      );
      await audit(runtime, principal, "query.updated", "tracked_query", id);
      return context.json({ data: { id, nextRunAt } });
    },
  );

  routes.patch(
    "/queries/:id/status",
    zValidator("param", IdParamSchema),
    zValidator("json", QueryStatusSchema),
    async (context) => {
      const principal = requireRole(context, "editor");
      const { id } = context.req.valid("param");
      const { isActive } = context.req.valid("json");
      const current = await requireQuery(runtime, principal.workspaceId, id);
      if (current.is_active === isActive) {
        return context.json({ data: { id, isActive } });
      }
      const claimId = crypto.randomUUID();
      if (isActive) await usage.claimPrompts(principal.workspaceId, claimId, [id]);
      try {
        await runtime.database.query(
          "UPDATE tracked_queries SET is_active = $1, updated_at = now() WHERE id = $2",
          [isActive, id],
        );
      } catch (error) {
        if (isActive) await usage.releaseResourceClaim(principal.workspaceId, claimId);
        throw error;
      }
      if (!isActive) await usage.releaseResources(principal.workspaceId, "prompt", [id]);
      await audit(runtime, principal, "query.status_updated", "tracked_query", id, { isActive });
      return context.json({ data: { id, isActive } });
    },
  );

  routes.delete("/queries/:id", zValidator("param", IdParamSchema), async (context) => {
    const principal = requireRole(context, "editor");
    const { id } = context.req.valid("param");
    await requireQuery(runtime, principal.workspaceId, id);
    await runtime.database.query(
      `UPDATE tracked_queries SET deleted_at = now(), is_active = false, updated_at = now()
       WHERE id = $1`,
      [id],
    );
    await usage.releaseResources(principal.workspaceId, "prompt", [id]);
    await audit(runtime, principal, "query.deleted", "tracked_query", id);
    return context.json({ data: { deleted: true } });
  });

  routes.get(
    "/projects/:projectId/tags",
    zValidator("param", ProjectIdParamSchema),
    async (context) => {
      const principal = context.get("principal");
      const { projectId } = context.req.valid("param");
      await requireProject(runtime, principal.workspaceId, projectId);
      const tags = await runtime.database.query<{
        id: string;
        name: string;
        color_index: number;
        usage_count: number;
      } & QueryResultRow>(
        `SELECT tag.id, tag.name, tag.color_index, COUNT(query.id)::integer AS usage_count
         FROM prompt_tags tag
         LEFT JOIN tracked_query_tags assignment ON assignment.tag_id = tag.id
         LEFT JOIN tracked_queries query
           ON query.id = assignment.tracked_query_id AND query.deleted_at IS NULL
         WHERE tag.project_id = $1
         GROUP BY tag.id, tag.name, tag.color_index
         HAVING COUNT(query.id) > 0
         ORDER BY usage_count DESC, lower(tag.name), tag.id`,
        [projectId],
      );
      return context.json({
        data: tags.rows.map((tag) => ({
          id: tag.id,
          name: tag.name,
          colorIndex: tag.color_index,
          usageCount: tag.usage_count,
        })),
      });
    },
  );

  routes.patch(
    "/projects/:projectId/queries/tags",
    zValidator("param", ProjectIdParamSchema),
    zValidator("json", PromptTagMutationSchema),
    async (context) => {
      const principal = requireRole(context, "editor");
      const { projectId } = context.req.valid("param");
      const input = context.req.valid("json");
      await requireProject(runtime, principal.workspaceId, projectId);
      const ids = [...new Set(input.queryIds)];
      const owned = await runtime.database.query<{ id: string } & QueryResultRow>(
        `SELECT id FROM tracked_queries
         WHERE project_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
        [projectId, ids],
      );
      if (owned.rows.length !== ids.length) {
        throw new ApiError(404, "query_not_found", "One or more tracked prompts were not found.");
      }
      await runtime.database.transaction(async (transaction) => {
        if (input.mode === "add") {
          const tags = await resolveTags(transaction, projectId, input.tagNames);
          for (const id of ids) await assignTags(transaction, id, input.tagNames, tags);
        } else {
          await transaction.query(
            `DELETE FROM tracked_query_tags assignment USING prompt_tags tag
             WHERE assignment.tag_id = tag.id AND assignment.tracked_query_id = ANY($1::uuid[])
               AND tag.project_id = $2 AND tag.normalized_name = ANY($3::text[])`,
            [ids, projectId, input.tagNames.map(promptTagKey)],
          );
        }
      });
      await audit(runtime, principal, "query.tags_updated", "project", projectId, {
        mode: input.mode,
        queryCount: ids.length,
        tagNames: input.tagNames,
      });
      return context.json({ data: { updatedCount: ids.length, mode: input.mode } });
    },
  );

  routes.get(
    "/analytics/prompts",
    zValidator("query", PromptAnalyticsSchema),
    async (context) => {
      const principal = context.get("principal");
      const input = context.req.valid("query");
      await requireProject(runtime, principal.workspaceId, input.projectId);
      const values: unknown[] = [input.projectId];
      const clauses = ["query.project_id = $1", "query.deleted_at IS NULL"];
      if (input.search) {
        values.push(input.search.toLowerCase());
        clauses.push(`position($${values.length} in lower(query.query_text)) > 0`);
      }
      if (input.locationCode !== undefined) {
        values.push(input.locationCode);
        clauses.push(`query.location_code = $${values.length}`);
      }
      if (input.languageCode) {
        values.push(input.languageCode);
        clauses.push(`query.language_code = $${values.length}`);
      }
      if (input.tagIds?.length) {
        values.push(input.tagIds);
        const tagIdsIndex = values.length;
        values.push(input.tagIds.length);
        clauses.push(
          `(SELECT COUNT(DISTINCT assignment.tag_id)::integer
            FROM tracked_query_tags assignment
            WHERE assignment.tracked_query_id = query.id
              AND assignment.tag_id = ANY($${tagIdsIndex}::uuid[])) = $${values.length}`,
        );
      }
      const totalValues = [...values];
      const totalClauses = [...clauses];
      const cursor = decodePromptCursor(input.cursor);
      if (cursor) {
        values.push(cursor.createdAt, cursor.id);
        clauses.push(
          `(query.created_at < $${values.length - 1}
            OR (query.created_at = $${values.length - 1} AND query.id < $${values.length}))`,
        );
      }
      values.push(input.limit + 1);
      const limitIndex = values.length;
      const offsetClause = !cursor && input.offset !== undefined
        ? (() => {
            values.push(input.offset);
            return ` OFFSET $${values.length}`;
          })()
        : "";
      const [totalResult, queryResult] = await Promise.all([
        runtime.database.query<{ total: number } & QueryResultRow>(
          `SELECT COUNT(*)::integer AS total FROM tracked_queries query
           WHERE ${totalClauses.join(" AND ")}`,
          totalValues,
        ),
        runtime.database.query<QueryRow & { tags: Array<{
          id: string;
          name: string;
          colorIndex: number;
        }> }>(
          `SELECT query.*,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', tag.id,
                'name', tag.name,
                'colorIndex', tag.color_index
              ) ORDER BY lower(tag.name), tag.id)
              FROM tracked_query_tags assignment
              JOIN prompt_tags tag ON tag.id = assignment.tag_id
              WHERE assignment.tracked_query_id = query.id
            ), '[]'::jsonb) AS tags
           FROM tracked_queries query
           WHERE ${clauses.join(" AND ")}
           ORDER BY query.created_at DESC, query.id DESC
           LIMIT $${limitIndex}${offsetClause}`,
          values,
        ),
      ]);
      const hasMore = queryResult.rows.length > input.limit;
      const rows = queryResult.rows.slice(0, input.limit);
      return context.json({
        data: rows.map((row) => ({
          id: row.id,
          queryText: row.query_text,
          locationCode: row.location_code,
          languageCode: row.language_code,
          scheduleCadence: row.schedule_cadence,
          scheduleTime: row.schedule_time,
          scheduleTimezone: row.schedule_timezone,
          isActive: row.is_active,
          latestSnapshotId: null,
          latestCapturedAt: null,
          snapshotCount: 0,
          latestRunStatus: null,
          tags: row.tags,
          sourceCount: null,
          mentionCount: null,
          mentionRate: null,
          citationCount: null,
          mentionChange: null,
        })),
        page: {
          nextCursor: hasMore && rows.length > 0
            ? encodePromptCursor(rows.at(-1)!.created_at, rows.at(-1)!.id)
            : null,
          total: totalResult.rows[0]?.total ?? 0,
        },
      });
    },
  );

  return routes;
}

async function requireProject(
  runtime: PortableRuntime,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  const project = await runtime.database.query(
    `SELECT 1 FROM projects WHERE id = $1 AND workspace_id = $2
     AND deleted_at IS NULL AND archived_at IS NULL`,
    [projectId, workspaceId],
  );
  if (project.rowCount === 0) throw new ApiError(404, "project_not_found", "Project not found.");
}

async function requireQuery(
  runtime: PortableRuntime,
  workspaceId: string,
  id: string,
): Promise<QueryRow> {
  const result = await runtime.database.query<QueryRow>(
    `SELECT query.* FROM tracked_queries query
     JOIN projects project ON project.id = query.project_id
     WHERE query.id = $1 AND project.workspace_id = $2
       AND query.deleted_at IS NULL AND project.deleted_at IS NULL
       AND project.archived_at IS NULL`,
    [id, workspaceId],
  );
  const query = result.rows[0];
  if (!query) throw new ApiError(404, "query_not_found", "Tracked query not found.");
  return query;
}

async function insertQuery(
  transaction: QueryExecutor,
  id: string,
  projectId: string,
  queryText: string,
  input: Omit<QueryInput, "queryText"> | QueryInput,
): Promise<string> {
  const nextRunAt = calculateNextRun(input.schedule);
  await transaction.query(
    `INSERT INTO tracked_queries (
      id, project_id, query_text, location_code, language_code, force_web_search,
      schedule_cadence, schedule_time, schedule_weekday, schedule_timezone,
      next_run_at, is_active, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, now(), now())`,
    [
      id,
      projectId,
      queryText,
      input.locationCode,
      input.languageCode,
      input.forceWebSearch,
      input.schedule.cadence,
      input.schedule.time,
      input.schedule.cadence === "weekly" ? input.schedule.weekday : null,
      input.schedule.timezone,
      nextRunAt,
    ],
  );
  return nextRunAt;
}

async function resolveTags(
  transaction: QueryExecutor,
  projectId: string,
  names: readonly string[],
): Promise<Map<string, TagRow>> {
  const uniqueNames = uniquePromptTagNames([...names]);
  const tags = new Map<string, TagRow>();
  if (uniqueNames.length === 0) return tags;
  await transaction.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [projectId]);
  const normalizedNames = uniqueNames.map(promptTagKey);
  const existing = await transaction.query<TagRow>(
    `SELECT id, name, normalized_name, color_index FROM prompt_tags
     WHERE project_id = $1 AND normalized_name = ANY($2::text[])`,
    [projectId, normalizedNames],
  );
  for (const tag of existing.rows) tags.set(tag.normalized_name, tag);
  const missingNames = uniqueNames.filter((name) => !tags.has(promptTagKey(name)));
  if (missingNames.length > 0) {
    const count = await transaction.query<{ count: number } & QueryResultRow>(
      "SELECT COUNT(*)::integer AS count FROM prompt_tags WHERE project_id = $1",
      [projectId],
    );
    if ((count.rows[0]?.count ?? 0) + missingNames.length > MAX_PROJECT_TAGS) {
      throw new ApiError(
        409,
        "project_tag_limit",
        `A project can have at most ${MAX_PROJECT_TAGS} prompt tags.`,
      );
    }
  }
  for (const name of missingNames) {
    const normalizedName = promptTagKey(name);
    const result = await transaction.query<TagRow>(
      `INSERT INTO prompt_tags (
        id, project_id, name, normalized_name, color_index, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, now(), now())
      RETURNING id, name, normalized_name, color_index`,
      [crypto.randomUUID(), projectId, name, normalizedName, promptTagColorIndex(name)],
    );
    const tag = result.rows[0];
    if (!tag) throw new Error("Prompt tag upsert returned no row.");
    tags.set(normalizedName, tag);
  }
  return tags;
}

async function assignTags(
  transaction: QueryExecutor,
  queryId: string,
  names: readonly string[],
  tags: ReadonlyMap<string, TagRow>,
): Promise<void> {
  const current = await transaction.query<{ normalized_name: string } & QueryResultRow>(
    `SELECT tag.normalized_name FROM tracked_query_tags assignment
     JOIN prompt_tags tag ON tag.id = assignment.tag_id
     WHERE assignment.tracked_query_id = $1`,
    [queryId],
  );
  const combined = new Set(current.rows.map((tag) => tag.normalized_name));
  for (const name of names) combined.add(promptTagKey(name));
  if (combined.size > MAX_PROMPT_TAGS) {
    throw new ApiError(409, "prompt_tag_limit", `A prompt can have at most ${MAX_PROMPT_TAGS} tags.`);
  }
  for (const name of uniquePromptTagNames([...names])) {
    const tag = tags.get(promptTagKey(name));
    if (!tag) throw new Error("Resolved prompt tag is missing.");
    await transaction.query(
      `INSERT INTO tracked_query_tags (tracked_query_id, tag_id, created_at)
       VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`,
      [queryId, tag.id],
    );
  }
}

function scheduleFromRow(row: QueryRow): Schedule {
  return row.schedule_cadence === "weekly"
    ? {
        cadence: "weekly",
        time: row.schedule_time,
        timezone: row.schedule_timezone,
        weekday: row.schedule_weekday ?? 1,
      }
    : {
        cadence: "daily",
        time: row.schedule_time,
        timezone: row.schedule_timezone,
      };
}

function encodePromptCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, createdAt: createdAt.toISOString(), id }))
    .toString("base64url");
}

function decodePromptCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      v?: unknown;
      createdAt?: unknown;
      id?: unknown;
    };
    if (
      value.v !== 1
      || typeof value.createdAt !== "string"
      || !Number.isFinite(Date.parse(value.createdAt))
      || typeof value.id !== "string"
      || !z.string().uuid().safeParse(value.id).success
    ) {
      throw new Error("Invalid cursor.");
    }
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    throw new ApiError(400, "invalid_cursor", "The prompt cursor is invalid.");
  }
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
