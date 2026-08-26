import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/portable/config";

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://belki:secret@localhost:5432/belki",
    APP_BASE_URL: "http://localhost:3000",
    APP_CRYPTO_KEY: "a".repeat(32),
    BOOTSTRAP_TOKEN: "b".repeat(32),
    S3_BUCKET: "belki-evidence",
    ...overrides,
  };
}

describe("portable runtime configuration", () => {
  it("parses safe self-hosted defaults", () => {
    const config = loadConfig(environment());
    expect(config).toMatchObject({
      PORT: 3000,
      DATABASE_POOL_MAX: 20,
      DEPLOYMENT_MODE: "self_hosted",
      PAYMENT_MODE: "disabled",
      EMAIL_MODE: "disabled",
      INFERENCE_MODE: "disabled",
    });
  });

  it("requires paired S3 credentials", () => {
    expect(() => loadConfig(environment({ S3_ACCESS_KEY_ID: "belki" }))).toThrow(
      /S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY/u,
    );
  });

  it("fails managed startup without the OIDC trust secret", () => {
    expect(() => loadConfig(environment({ DEPLOYMENT_MODE: "managed" }))).toThrow(
      /OIDC_TRUST_SECRET/u,
    );
  });

  it("requires SMTP fields only when SMTP is enabled", () => {
    expect(() => loadConfig(environment({ EMAIL_MODE: "smtp" }))).toThrow(/SMTP_HOST/u);
  });
});
