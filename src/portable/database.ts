import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import type { PortableConfig } from "./config";
import { databaseSsl } from "./config";
import type { Database, QueryExecutor } from "./contracts";

class TransactionExecutor implements QueryExecutor {
  constructor(private readonly client: PoolClient) {}

  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    return this.client.query<Row>(text, values ? [...values] : undefined);
  }
}

export class PostgresDatabase implements Database {
  readonly pool: Pool;

  constructor(config: PortableConfig) {
    this.pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: config.DATABASE_POOL_MAX,
      ssl: databaseSsl(config),
      application_name: "belki-portable",
    });
  }

  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    return this.pool.query<Row>(text, values ? [...values] : undefined);
  }

  async transaction<T>(operation: (database: QueryExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(new TransactionExecutor(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async check(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
