import { makeWorkerUtils, type WorkerUtils } from "graphile-worker";
import type { PortableConfig } from "../config";
import type { Database, JobDispatcher, JobOptions } from "../contracts";

export class GraphileJobDispatcher implements JobDispatcher {
  private constructor(
    private readonly workerUtils: WorkerUtils,
    private readonly database: Database,
    private readonly schema: string,
  ) {}

  static async create(config: PortableConfig, database: Database): Promise<GraphileJobDispatcher> {
    const workerUtils = await makeWorkerUtils({
      connectionString: config.DATABASE_URL,
      schema: config.GRAPHILE_SCHEMA,
      maxPoolSize: Math.min(config.DATABASE_POOL_MAX, 10),
    });
    return new GraphileJobDispatcher(workerUtils, database, config.GRAPHILE_SCHEMA);
  }

  async dispatch(task: string, payload: unknown, options: JobOptions = {}): Promise<string> {
    const job = await this.workerUtils.addJob(task, payload, options);
    return String(job.id);
  }

  async check(): Promise<void> {
    const result = await this.database.query<{ table_name: string | null }>(
      "SELECT to_regclass($1) AS table_name",
      [`${this.schema}.jobs`],
    );
    if (!result.rows[0]?.table_name) throw new Error("job_schema_not_migrated");
  }

  async close(): Promise<void> {
    await this.workerUtils.release();
  }
}
