import { run } from "graphile-worker";
import { loadConfig } from "./config";
import { taskList, workerCrontab } from "./jobs/tasks";

const config = loadConfig();
const runner = await run({
  connectionString: config.DATABASE_URL,
  schema: config.GRAPHILE_SCHEMA,
  concurrency: config.WORKER_CONCURRENCY,
  noHandleSignals: true,
  taskList,
  crontab: workerCrontab,
});

console.log(JSON.stringify({
  level: "info",
  message: "worker_started",
  concurrency: config.WORKER_CONCURRENCY,
}));

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void runner.stop(signal).catch((error: unknown) => {
      console.error(JSON.stringify({
        level: "error",
        message: "worker_shutdown_failed",
        error: error instanceof Error ? error.message : String(error),
      }));
      process.exitCode = 1;
    });
  });
}

await runner.promise;
