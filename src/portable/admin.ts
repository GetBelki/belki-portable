import { loadConfig } from "./config";
import { PostgresDatabase } from "./database";
import { PostgresUsageRepository } from "./usage/repository";

const [command, argument] = process.argv.slice(2);
const config = loadConfig();
const database = new PostgresDatabase(config);

try {
  if (command === "usage-summary" && argument) {
    const usage = new PostgresUsageRepository(database);
    console.log(JSON.stringify(await usage.summary(argument), null, 2));
  } else if (command === "database-check") {
    await database.check();
    console.log(JSON.stringify({ ok: true }));
  } else {
    console.error("Usage: pnpm admin -- <database-check|usage-summary WORKSPACE_ID>");
    process.exitCode = 2;
  }
} finally {
  await database.close();
}
