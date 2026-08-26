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
  app.use("*", async (context, next) => {
    context.set("requestId", context.req.header("x-request-id") ?? requestId());
    await next();
    context.header("x-content-type-options", "nosniff");
    context.header("referrer-policy", "strict-origin-when-cross-origin");
    context.header("x-frame-options", "DENY");
  });
  app.onError((error, context) => errorResponse(context, error));

  app.get("/health/live", (context) => context.json({
    status: "ok",
    service: "belki-portable-web",
  }));
  app.get("/health/ready", async (context) => {
    const report = await readiness({
      config: runtime.config,
      database: runtime.database,
      jobs: runtime.jobs,
      objectStore: runtime.objectStore,
      inference: runtime.inference,
      email: runtime.email,
      operatorIdentity: runtime.operatorIdentity,
    });
    return context.json(report, report.ready ? 200 : 503);
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
