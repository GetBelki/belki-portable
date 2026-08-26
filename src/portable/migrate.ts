import { resolve } from "node:path";
import { runMigrations as migrateGraphileWorker } from "graphile-worker";
import { runner } from "node-pg-migrate";
import { loadConfig, type PortableConfig } from "./config";

export async function migrate(config: PortableConfig): Promise<void> {
  await runner({
    databaseUrl: config.DATABASE_URL,
    dir: resolve(process.cwd(), "migrations/postgres"),
    direction: "up",
    migrationsTable: "belki_migrations",
    checkOrder: true,
    singleTransaction: true,
    advisoryLockMode: "wait",
    migrationLoaderStrategies: [{ extensions: [".sql"], loader: "sql" }],
  });
  await migrateGraphileWorker({
    connectionString: config.DATABASE_URL,
    schema: config.GRAPHILE_SCHEMA,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await migrate(loadConfig());
}
