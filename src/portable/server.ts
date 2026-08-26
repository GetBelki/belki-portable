import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createRuntime, gracefulShutdown } from "./runtime";

const config = loadConfig();
const runtime = await createRuntime(config);
const app = createApp(runtime, "./dist/client");
const server = serve({
  fetch: app.fetch,
  hostname: config.HOST,
  port: config.PORT,
});

console.log(JSON.stringify({
  level: "info",
  message: "server_started",
  host: config.HOST,
  port: config.PORT,
}));

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), config.SHUTDOWN_TIMEOUT_MS);
    timeout.unref();
    void gracefulShutdown(server, runtime, signal)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(JSON.stringify({
          level: "error",
          message: "shutdown_failed",
          error: error instanceof Error ? error.message : String(error),
        }));
        process.exit(1);
      });
  });
}
