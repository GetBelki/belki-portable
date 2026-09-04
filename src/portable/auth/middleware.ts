import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { QueryResultRow } from "pg";
import type { Principal, Role, WorkspaceStatus } from "../../shared/contracts";
import type { PortableConfig } from "../config";
import type { Database } from "../contracts";
import { ApiError } from "../http";
import { randomToken, sha256, timingSafeTextEqual } from "../security/crypto";
import { trustedClientIp } from "./client-ip";

const SESSION_COOKIE = "ai_tracker_session";
const CSRF_COOKIE = "ai_tracker_csrf";
const SESSION_SECONDS = 60 * 60 * 24 * 14;

export interface PortableVariables {
  principal: Principal;
  requestId: string;
}

export type PortableAppEnv = { Variables: PortableVariables };

interface SessionRow extends QueryResultRow {
  session_id: string;
  user_id: string;
  workspace_id: string;
  email: string;
  display_name: string;
  role: Role;
  csrf_hash: string;
  expires_at: Date;
  last_seen_at: Date;
  status: string;
  workspace_status: WorkspaceStatus;
}

const PUBLIC_PATHS = new Set([
  "/api/v1/status",
  "/api/v1/setup",
  "/api/v1/auth/login",
]);

export interface AuthDependencies {
  config: PortableConfig;
  database: Database;
}

export function authMiddleware(dependencies: AuthDependencies) {
  return createMiddleware<PortableAppEnv>(async (context, next) => {
    if (PUBLIC_PATHS.has(context.req.path)) {
      await next();
      return;
    }
    const sessionToken = getCookie(context, SESSION_COOKIE);
    if (!sessionToken) throw new ApiError(401, "authentication_required", "Sign in is required.");
    const session = await dependencies.database.query<SessionRow>(
      `SELECT
        session.id AS session_id, session.user_id, membership.workspace_id,
        app_user.email, app_user.display_name, membership.role, session.csrf_hash,
        session.expires_at, session.last_seen_at, app_user.status,
        workspace.status AS workspace_status
       FROM sessions session
       JOIN users app_user ON app_user.id = session.user_id
       JOIN memberships membership
         ON membership.user_id = app_user.id
        AND membership.workspace_id = session.active_workspace_id
       JOIN workspaces workspace ON workspace.id = membership.workspace_id
       WHERE session.token_hash = $1
         AND membership.status = 'active'
         AND workspace.status != 'deleted'
       LIMIT 1`,
      [sha256(sessionToken)],
    );
    const row = session.rows[0];
    if (!row || row.status !== "active" || row.expires_at.getTime() <= Date.now()) {
      deleteAuthCookies(context);
      throw new ApiError(401, "session_expired", "Your session has expired.");
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(context.req.method)) {
      const cookieCsrf = getCookie(context, CSRF_COOKIE);
      const headerCsrf = context.req.header("x-csrf-token");
      if (
        !cookieCsrf ||
        !headerCsrf ||
        !timingSafeTextEqual(cookieCsrf, headerCsrf) ||
        !timingSafeTextEqual(sha256(headerCsrf), row.csrf_hash)
      ) {
        throw new ApiError(403, "csrf_failed", "The request could not be verified.");
      }
    }
    context.set("principal", {
      sessionId: row.session_id,
      userId: row.user_id,
      workspaceId: row.workspace_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      workspaceStatus: row.workspace_status,
    });
    await next();
    if (Date.now() - row.last_seen_at.getTime() >= 5 * 60 * 1000) {
      await dependencies.database.query(
        "UPDATE sessions SET last_seen_at = now() WHERE id = $1",
        [row.session_id],
      );
    }
  });
}

export async function createSession(
  context: Context<PortableAppEnv>,
  dependencies: AuthDependencies,
  userId: string,
  requestedWorkspaceId?: string,
): Promise<void> {
  const membership = await dependencies.database.query<{ workspace_id: string } & QueryResultRow>(
    `SELECT membership.workspace_id
     FROM memberships membership
     JOIN workspaces workspace ON workspace.id = membership.workspace_id
     WHERE membership.user_id = $1 AND membership.status = 'active'
       AND workspace.status != 'deleted'
       AND ($2::uuid IS NULL OR membership.workspace_id = $2::uuid)
     ORDER BY membership.created_at, membership.workspace_id
     LIMIT 1`,
    [userId, requestedWorkspaceId ?? null],
  );
  const workspaceId = membership.rows[0]?.workspace_id;
  if (!workspaceId) {
    throw new ApiError(403, "workspace_access_required", "No accessible workspace was found.");
  }
  const token = randomToken();
  const csrf = randomToken();
  const ip = trustedClientIp(context.req.raw, dependencies.config);
  await dependencies.database.query(
    `INSERT INTO sessions (
      id, user_id, token_hash, csrf_hash, expires_at, created_at, last_seen_at,
      ip_hash, user_agent, active_workspace_id
    ) VALUES ($1, $2, $3, $4, now() + interval '14 days', now(), now(), $5, $6, $7)`,
    [
      crypto.randomUUID(),
      userId,
      sha256(token),
      sha256(csrf),
      ip ? sha256(ip) : null,
      context.req.header("user-agent")?.slice(0, 500) ?? null,
      workspaceId,
    ],
  );
  const secure = new URL(dependencies.config.APP_BASE_URL).protocol === "https:";
  setCookie(context, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_SECONDS,
  });
  setCookie(context, CSRF_COOKIE, csrf, {
    httpOnly: false,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_SECONDS,
  });
}

export function deleteAuthCookies(context: Context): void {
  deleteCookie(context, SESSION_COOKIE, { path: "/" });
  deleteCookie(context, CSRF_COOKIE, { path: "/" });
}

const ROLE_LEVEL: Record<Role, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

export function requireRole(context: Context<PortableAppEnv>, minimum: Role): Principal {
  const principal = context.get("principal");
  if (ROLE_LEVEL[principal.role] < ROLE_LEVEL[minimum]) {
    throw new ApiError(403, "insufficient_role", `This action requires the ${minimum} role.`);
  }
  return principal;
}
