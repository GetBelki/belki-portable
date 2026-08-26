import type { ServerType } from "@hono/node-server";
import type { PortableConfig } from "./config";
import type {
  Database,
  EmailSender,
  JobDispatcher,
  ObjectStore,
  OperatorIdentity,
  StructuredInferenceClient,
} from "./contracts";
import { createEmailSender } from "./adapters/email";
import { createInferenceClient } from "./adapters/inference";
import { GraphileJobDispatcher } from "./adapters/jobs";
import { S3ObjectStore } from "./adapters/object-store";
import { ProxyOperatorIdentity } from "./adapters/operator-identity";
import { PostgresDatabase } from "./database";

export interface PortableRuntime {
  config: PortableConfig;
  database: Database;
  jobs: JobDispatcher;
  objectStore: ObjectStore;
  inference: StructuredInferenceClient;
  email: EmailSender;
  operatorIdentity: OperatorIdentity;
}

export async function createRuntime(config: PortableConfig): Promise<PortableRuntime> {
  const database = new PostgresDatabase(config);
  const jobs = await GraphileJobDispatcher.create(config, database);
  return {
    config,
    database,
    jobs,
    objectStore: new S3ObjectStore(config),
    inference: createInferenceClient(config),
    email: createEmailSender(config),
    operatorIdentity: new ProxyOperatorIdentity(config),
  };
}

export async function closeRuntime(runtime: PortableRuntime): Promise<void> {
  await Promise.allSettled([runtime.jobs.close(), runtime.database.close()]);
}

export async function gracefulShutdown(
  server: ServerType,
  runtime: PortableRuntime,
  signal: NodeJS.Signals,
): Promise<void> {
  console.log(JSON.stringify({ level: "info", message: "shutdown_started", signal }));
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await closeRuntime(runtime);
}
