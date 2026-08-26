import type { PortableConfig } from "./config";
import type {
  Database,
  EmailSender,
  JobDispatcher,
  ObjectStore,
  OperatorIdentity,
  StructuredInferenceClient,
} from "./contracts";

export interface HealthCheckResult {
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

export interface ReadinessReport {
  ready: boolean;
  checkedAt: string;
  checks: Record<string, HealthCheckResult>;
}

interface HealthDependencies {
  config: PortableConfig;
  database: Database;
  jobs: JobDispatcher;
  objectStore: ObjectStore;
  inference: StructuredInferenceClient;
  email: EmailSender;
  operatorIdentity: OperatorIdentity;
}

async function runCheck(operation: () => Promise<void>, detail?: string): Promise<HealthCheckResult> {
  const startedAt = performance.now();
  try {
    await operation();
    return {
      ok: true,
      latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
      ...(detail ? { detail } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readiness(dependencies: HealthDependencies): Promise<ReadinessReport> {
  const checks = [
    ["postgres", runCheck(() => dependencies.database.check())],
    ["migrations", runCheck(async () => {
      const result = await dependencies.database.query<{ table_name: string | null }>(
        "SELECT to_regclass('public.tracked_queries') AS table_name",
      );
      if (!result.rows[0]?.table_name) throw new Error("application_schema_not_migrated");
    })],
    ["jobs", runCheck(() => dependencies.jobs.check())],
    ["objectStorage", runCheck(() => dependencies.objectStore.check())],
    [
      "inference",
      runCheck(
        () => dependencies.inference.check(),
        dependencies.config.INFERENCE_MODE,
      ),
    ],
    [
      "email",
      runCheck(
        () => dependencies.email.check(),
        dependencies.config.EMAIL_MODE,
      ),
    ],
    [
      "stripe",
      runCheck(
        () => Promise.resolve(),
        dependencies.config.PAYMENT_MODE,
      ),
    ],
    [
      "operatorIdentity",
      runCheck(
        () => dependencies.operatorIdentity.check(),
        dependencies.config.DEPLOYMENT_MODE,
      ),
    ],
  ] as const;
  const result = Object.fromEntries(
    await Promise.all(checks.map(async ([name, check]) => [name, await check] as const)),
  );
  return {
    ready: Object.values(result).every((check) => check.ok),
    checkedAt: new Date().toISOString(),
    checks: result,
  };
}
