import { z } from "zod";

const optionalString = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().optional(),
);

const integer = (fallback: number, minimum: number, maximum: number) =>
  z.preprocess(
    (value) => value === undefined || value === "" ? fallback : value,
    z.coerce.number().int().min(minimum).max(maximum),
  );

const boolean = (fallback: boolean) => z.preprocess(
  (value) => {
    if (value === undefined || value === "") return fallback;
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    return value;
  },
  z.boolean(),
);

export const PortableConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: integer(3000, 1, 65_535),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  SHUTDOWN_TIMEOUT_MS: integer(30_000, 1_000, 300_000),
  TRUST_PROXY_HEADERS: boolean(false),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: integer(20, 1, 200),
  DATABASE_SSL_MODE: z.enum(["disable", "require", "no-verify"]).default("disable"),
  GRAPHILE_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/u).default("graphile_worker"),
  WORKER_CONCURRENCY: integer(10, 1, 200),

  APP_BASE_URL: z.string().url(),
  APP_NAME: z.string().trim().min(1).max(100).default("Belki"),
  APP_CRYPTO_KEY: z.string().min(32),
  BOOTSTRAP_TOKEN: z.string().min(32),
  DEFAULT_MONTHLY_RUN_CAP: integer(1_000_000, 1_000, 100_000_000),
  DEPLOYMENT_MODE: z.enum(["self_hosted", "managed"]).default("self_hosted"),
  PAYMENT_MODE: z.enum(["disabled", "stripe_direct", "stripe_managed"]).default("disabled"),

  DATAFORSEO_LOGIN: optionalString,
  DATAFORSEO_PASSWORD: optionalString,
  DATAFORSEO_WEBHOOK_TOKEN: optionalString,

  S3_ENDPOINT: optionalString,
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  S3_FORCE_PATH_STYLE: boolean(false),

  EMAIL_MODE: z.enum(["disabled", "smtp"]).default("disabled"),
  SMTP_HOST: optionalString,
  SMTP_PORT: integer(1025, 1, 65_535),
  SMTP_SECURE: boolean(false),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  EMAIL_FROM_ADDRESS: optionalString,
  EMAIL_FROM_NAME: optionalString,

  INFERENCE_MODE: z.enum(["disabled", "openai_compatible"]).default("disabled"),
  INFERENCE_BASE_URL: optionalString.pipe(z.string().url().optional()),
  INFERENCE_API_KEY: optionalString,
  INFERENCE_MODEL: optionalString,

  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  STRIPE_ENVIRONMENT: z.enum(["test", "live"]).default("test"),

  OIDC_EMAIL_HEADER: z.string().regex(/^x-[a-z0-9-]+$/u).default("x-auth-request-email"),
  OIDC_TRUST_HEADER: z.string().regex(/^x-[a-z0-9-]+$/u).default("x-belki-proxy-secret"),
  OIDC_TRUST_SECRET: optionalString,
}).superRefine((config, context) => {
  const requireField = (field: keyof typeof config, message: string) => {
    if (!config[field]) context.addIssue({ code: "custom", path: [field], message });
  };

  if (Boolean(config.S3_ACCESS_KEY_ID) !== Boolean(config.S3_SECRET_ACCESS_KEY)) {
    context.addIssue({
      code: "custom",
      path: ["S3_ACCESS_KEY_ID"],
      message: "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be configured together.",
    });
  }
  if (config.EMAIL_MODE === "smtp") {
    requireField("SMTP_HOST", "SMTP_HOST is required when EMAIL_MODE=smtp.");
    requireField("EMAIL_FROM_ADDRESS", "EMAIL_FROM_ADDRESS is required when EMAIL_MODE=smtp.");
    if (Boolean(config.SMTP_USER) !== Boolean(config.SMTP_PASSWORD)) {
      context.addIssue({
        code: "custom",
        path: ["SMTP_USER"],
        message: "SMTP_USER and SMTP_PASSWORD must be configured together.",
      });
    }
  }
  if (config.INFERENCE_MODE === "openai_compatible") {
    requireField(
      "INFERENCE_BASE_URL",
      "INFERENCE_BASE_URL is required when INFERENCE_MODE=openai_compatible.",
    );
    requireField(
      "INFERENCE_MODEL",
      "INFERENCE_MODEL is required when INFERENCE_MODE=openai_compatible.",
    );
  }
  if (config.PAYMENT_MODE !== "disabled") {
    requireField("STRIPE_SECRET_KEY", "STRIPE_SECRET_KEY is required when Stripe is enabled.");
    requireField(
      "STRIPE_WEBHOOK_SECRET",
      "STRIPE_WEBHOOK_SECRET is required when Stripe is enabled.",
    );
  }
  if (config.DEPLOYMENT_MODE === "managed") {
    requireField(
      "OIDC_TRUST_SECRET",
      "OIDC_TRUST_SECRET is required in managed deployment mode.",
    );
  }
});

export type PortableConfig = z.infer<typeof PortableConfigSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): PortableConfig {
  return PortableConfigSchema.parse(environment);
}

export function databaseSsl(config: PortableConfig): false | { rejectUnauthorized: boolean } {
  if (config.DATABASE_SSL_MODE === "disable") return false;
  return { rejectUnauthorized: config.DATABASE_SSL_MODE === "require" };
}
