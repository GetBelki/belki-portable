import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createAuthRoutes } from "./auth/routes";
import { authMiddleware, type PortableAppEnv } from "./auth/middleware";
import { createProjectRoutes } from "./projects/routes";
import { createQueryRoutes } from "./queries/routes";
import { readiness } from "./health";
import { errorResponse, requestId } from "./http";
import type { PortableRuntime } from "./runtime";

export function createApp(runtime: PortableRuntime, staticRoot?: string): Hono<PortableAppEnv> {
  const app = new Hono<PortableAppEnv>();
  let readinessCache: { expiresAt: number; report: Awaited<ReturnType<typeof readiness>> } | null = null;
  app.use("*", async (context, next) => {
    context.set("requestId", context.req.header("x-request-id") ?? requestId());
    await next();
    context.header("x-content-type-options", "nosniff");
    context.header("referrer-policy", "strict-origin-when-cross-origin");
    context.header("x-frame-options", "DENY");
    context.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
    );
    context.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    context.header("cross-origin-opener-policy", "same-origin");
    if (runtime.config.NODE_ENV === "production" && runtime.config.APP_BASE_URL.startsWith("https://")) {
      context.header("strict-transport-security", "max-age=31536000");
    }
  });
  app.onError((error, context) => errorResponse(context, error));

  app.get("/health/live", (context) => context.json({
    status: "ok",
    service: "belki-portable-web",
  }));
  app.get("/health/ready", async (context) => {
    if (!readinessCache || readinessCache.expiresAt <= Date.now()) {
      const report = await readiness({
        config: runtime.config,
        database: runtime.database,
        jobs: runtime.jobs,
        objectStore: runtime.objectStore,
        inference: runtime.inference,
        email: runtime.email,
        operatorIdentity: runtime.operatorIdentity,
      });
      readinessCache = { expiresAt: Date.now() + 5_000, report };
      if (!report.ready) {
        console.warn(JSON.stringify({
          level: "warn",
          message: "readiness_check_failed",
          failedChecks: Object.entries(report.checks)
            .filter(([, check]) => !check.ok)
            .map(([name]) => name),
        }));
      }
    }
    context.header("cache-control", "no-store");
    return context.json({
      ready: readinessCache.report.ready,
      checkedAt: readinessCache.report.checkedAt,
    }, readinessCache.report.ready ? 200 : 503);
  });

  app.use("/api/v1/*", authMiddleware({
    config: runtime.config,
    database: runtime.database,
  }));
  app.route("/api/v1", createAuthRoutes({
    config: runtime.config,
    database: runtime.database,
    emailSender: runtime.email,
  }));
  app.route("/api/v1", createProjectRoutes(runtime));
  app.route("/api/v1", createQueryRoutes(runtime));

  if (staticRoot) {
    app.get("*", serveStatic({ root: staticRoot, precompressed: true }));
    app.get("*", serveStatic({ path: `${staticRoot}/index.html` }));
  }

  app.notFound((context) => {
    if (context.req.path.startsWith("/api/")) {
      return context.json({
        error: {
          code: "not_found",
          message: "API route not found.",
          requestId: context.get("requestId"),
        },
      }, 404);
    }
    return context.text("Not found", 404);
  });
  return app;
}
