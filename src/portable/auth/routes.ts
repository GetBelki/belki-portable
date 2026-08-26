import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { QueryResultRow } from "pg";
import { LoginSchema, SetupSchema } from "../../shared/contracts";
import type { EmailSender } from "../contracts";
import { ApiError } from "../http";
import { listProjects } from "../projects/repository";
import { hashPassword, sha256, timingSafeTextEqual, verifyPassword } from "../security/crypto";
import {
  createSession,
  deleteAuthCookies,
  type AuthDependencies,
  type PortableAppEnv,
} from "./middleware";

interface AuthRouteDependencies extends AuthDependencies {
  emailSender: EmailSender;
}

interface LoginRow extends QueryResultRow {
  id: string;
  status: string;
  iterations: number;
  salt: string;
  password_hash: string;
}

export function createAuthRoutes(dependencies: AuthRouteDependencies): Hono<PortableAppEnv> {
  const routes = new Hono<PortableAppEnv>();
  routes.get("/status", async (context) => {
    const owner = await dependencies.database.query<{ count: number } & QueryResultRow>(
      "SELECT COUNT(*)::integer AS count FROM memberships WHERE role = 'owner'",
    );
    return context.json({
      data: {
        setupRequired: (owner.rows[0]?.count ?? 0) === 0,
        emailDeliveryConfigured: dependencies.emailSender.configured,
      },
    });
  });

  routes.post("/setup", zValidator("json", SetupSchema), async (context) => {
    const input = context.req.valid("json");
    if (!timingSafeTextEqual(input.bootstrapToken, dependencies.config.BOOTSTRAP_TOKEN)) {
      throw new ApiError(403, "invalid_bootstrap_token", "The bootstrap token is not valid.");
    }
    const userId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const credential = await hashPassword(input.password);
    const cycleStartedAt = new Date(Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      1,
    ));
    const cycleEndsAt = new Date(Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth() + 1,
      1,
    ));
    await dependencies.database.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtext('belki:installation:setup'))");
      const existing = await transaction.query<{ count: number } & QueryResultRow>(
        "SELECT COUNT(*)::integer AS count FROM memberships WHERE role = 'owner'",
      );
      if ((existing.rows[0]?.count ?? 0) > 0) {
        throw new ApiError(409, "already_configured", "This installation is already configured.");
      }
      await transaction.query(
        `INSERT INTO workspaces (
          id, name, public_base_url, monthly_run_cap, timezone, status, plan_key,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, 'active', 'self_hosted', now(), now())`,
        [
          workspaceId,
          input.workspaceName,
          dependencies.config.APP_BASE_URL,
          input.monthlyRunCap,
          input.timezone,
        ],
      );
      await transaction.query(
        `INSERT INTO users (id, email, display_name, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'active', now(), now())`,
        [userId, input.email.toLowerCase(), input.displayName],
      );
      await transaction.query(
        `INSERT INTO password_credentials (
          user_id, algorithm, iterations, salt, password_hash, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, now(), now())`,
        [
          userId,
          credential.algorithm,
          credential.iterations,
          credential.salt,
          credential.passwordHash,
        ],
      );
      await transaction.query(
        `INSERT INTO memberships (workspace_id, user_id, role, status, created_at)
         VALUES ($1, $2, 'owner', 'active', now())`,
        [workspaceId, userId],
      );
      await transaction.query(
        `INSERT INTO billing_accounts (
          workspace_id, provider, payment_mode, plan_key, status, monthly_units,
          project_limit, prompt_limit, source_limit, cycle_started_at, cycle_ends_at,
          created_at, updated_at
        ) VALUES (
          $1, 'self_hosted', 'disabled', 'self_hosted', 'active', $2,
          1000000, 1000000, 4, $3, $4, now(), now()
        )`,
        [workspaceId, input.monthlyRunCap, cycleStartedAt, cycleEndsAt],
      );
      await transaction.query(
        `INSERT INTO usage_entitlements (
          workspace_id, plan_key, subscription_status, workspace_status, allowance,
          project_limit, prompt_limit, source_limit, cycle_started_at, cycle_ends_at,
          updated_at
        ) VALUES ($1, 'self_hosted', 'active', 'active', $2, 1000000, 1000000, 4, $3, $4, now())`,
        [workspaceId, input.monthlyRunCap, cycleStartedAt, cycleEndsAt],
      );
      await transaction.query(
        `INSERT INTO platform_operators (email, user_id, created_at, created_by_user_id)
         VALUES ($1, $2, now(), $2) ON CONFLICT (email) DO NOTHING`,
        [input.email.toLowerCase(), userId],
      );
      await transaction.query(
        `INSERT INTO audit_log (
          id, workspace_id, user_id, action, resource_type, resource_id, metadata, created_at
        ) VALUES ($1, $2, $3, 'installation.setup', 'workspace', $2::text, '{}'::jsonb, now())`,
        [crypto.randomUUID(), workspaceId, userId],
      );
    });
    await createSession(context, dependencies, userId, workspaceId);
    return context.json({ data: { workspaceId, userId } }, 201);
  });

  routes.post("/auth/login", zValidator("json", LoginSchema), async (context) => {
    const input = context.req.valid("json");
    const ip = context.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await checkLoginRateLimit(dependencies, sha256(`${input.email.toLowerCase()}|${ip}`));
    const result = await dependencies.database.query<LoginRow>(
      `SELECT app_user.id, app_user.status, credential.iterations,
        credential.salt, credential.password_hash
       FROM users app_user
       JOIN password_credentials credential ON credential.user_id = app_user.id
       WHERE lower(app_user.email) = lower($1)
       LIMIT 1`,
      [input.email],
    );
    const user = result.rows[0];
    if (
      !user ||
      user.status !== "active" ||
      !(await verifyPassword(input.password, user.salt, user.iterations, user.password_hash))
    ) {
      throw new ApiError(401, "invalid_credentials", "The email or password is incorrect.");
    }
    await dependencies.database.query(
      "UPDATE users SET last_login_at = now() WHERE id = $1",
      [user.id],
    );
    await createSession(context, dependencies, user.id);
    return context.json({ data: { signedIn: true } });
  });

  routes.get("/auth/session", async (context) => {
    const principal = context.get("principal");
    const [workspace, workspaces, projects, operator] = await Promise.all([
      dependencies.database.query<{
        id: string;
        name: string;
        status: string;
        plan_key: string;
        public_base_url: string;
      } & QueryResultRow>(
        `SELECT id, name, status, plan_key, public_base_url
         FROM workspaces WHERE id = $1`,
        [principal.workspaceId],
      ),
      dependencies.database.query<{
        id: string;
        name: string;
        status: string;
        plan_key: string;
        role: string;
      } & QueryResultRow>(
        `SELECT workspace.id, workspace.name, workspace.status, workspace.plan_key,
          membership.role
         FROM memberships membership
         JOIN workspaces workspace ON workspace.id = membership.workspace_id
         WHERE membership.user_id = $1 AND membership.status = 'active'
           AND workspace.status != 'deleted'
         ORDER BY lower(workspace.name), workspace.id`,
        [principal.userId],
      ),
      listProjects(dependencies.database, principal.workspaceId),
      dependencies.database.query(
        "SELECT 1 FROM platform_operators WHERE lower(email) = lower($1)",
        [principal.email],
      ),
    ]);
    const currentWorkspace = workspace.rows[0];
    if (!currentWorkspace) {
      throw new ApiError(500, "workspace_not_found", "The current workspace could not be loaded.");
    }
    return context.json({
      data: {
        user: {
          id: principal.userId,
          email: principal.email,
          displayName: principal.displayName,
          role: principal.role,
        },
        workspaceId: principal.workspaceId,
        workspace: {
          id: currentWorkspace.id,
          name: currentWorkspace.name,
          status: currentWorkspace.status,
          plan_key: currentWorkspace.plan_key,
          publicBaseUrl: dependencies.config.APP_BASE_URL,
        },
        workspaces: workspaces.rows,
        projects,
        capabilities: {
          emailDelivery: dependencies.emailSender.configured,
          publicOriginManaged: true,
        },
        csrfTokenPresent: Boolean(getCookie(context, "ai_tracker_csrf")),
        isPlatformOperator: (operator.rowCount ?? 0) > 0,
      },
    });
  });

  routes.post("/auth/logout", async (context) => {
    const principal = context.get("principal");
    await dependencies.database.query("DELETE FROM sessions WHERE id = $1", [principal.sessionId]);
    deleteAuthCookies(context);
    return context.json({ data: { signedOut: true } });
  });

  return routes;
}

async function checkLoginRateLimit(
  dependencies: AuthDependencies,
  key: string,
  maximum = 10,
): Promise<void> {
  const windowStartedAt = new Date(Math.floor(Date.now() / 900_000) * 900_000);
  const result = await dependencies.database.query<{ attempts: number } & QueryResultRow>(
    `INSERT INTO rate_limits (key, window_started_at, attempts)
     VALUES ($1, $2, 1)
     ON CONFLICT (key) DO UPDATE SET
       attempts = CASE
         WHEN rate_limits.window_started_at = excluded.window_started_at
           THEN rate_limits.attempts + 1
         ELSE 1
       END,
       window_started_at = excluded.window_started_at
     RETURNING attempts`,
    [key, windowStartedAt],
  );
  if ((result.rows[0]?.attempts ?? 1) > maximum) {
    throw new ApiError(429, "rate_limited", "Too many sign-in attempts. Try again later.");
  }
}
