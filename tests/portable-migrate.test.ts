import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/portable/config";

const { migrateGraphileWorker, runner } = vi.hoisted(() => ({
  migrateGraphileWorker: vi.fn().mockResolvedValue(undefined),
  runner: vi.fn().mockResolvedValue([]),
}));

vi.mock("node-pg-migrate", () => ({ runner }));
vi.mock("graphile-worker", () => ({ runMigrations: migrateGraphileWorker }));

import { migrate } from "../src/portable/migrate";

const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://belki:secret@localhost:5432/belki",
  APP_BASE_URL: "http://localhost:3000",
  APP_CRYPTO_KEY: "a".repeat(32),
  BOOTSTRAP_TOKEN: "b".repeat(32),
  S3_BUCKET: "belki-evidence",
});

describe("portable migration runner", () => {
  beforeEach(() => vi.clearAllMocks());

  it("groups paired up/down SQL files into one forward migration", async () => {
    await migrate(config);

    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      direction: "up",
      checkOrder: true,
      singleTransaction: true,
      migrationLoaderStrategies: [{ extensions: [".sql"], loader: "sql" }],
    }));
    expect(migrateGraphileWorker).toHaveBeenCalledWith({
      connectionString: config.DATABASE_URL,
      schema: config.GRAPHILE_SCHEMA,
    });
  });
});
