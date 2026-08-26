import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/portable/app";
import { loadConfig } from "../src/portable/config";
import type { PortableRuntime } from "../src/portable/runtime";

function runtime(databaseHealthy = true): PortableRuntime {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://belki:secret@localhost:5432/belki",
    APP_BASE_URL: "http://localhost:3000",
    APP_CRYPTO_KEY: "a".repeat(32),
    BOOTSTRAP_TOKEN: "b".repeat(32),
    S3_BUCKET: "belki-evidence",
  });
  return {
    config,
    database: {
      query: vi.fn().mockResolvedValue({
        command: "SELECT",
        rowCount: 1,
        oid: 0,
        fields: [],
        rows: [{ table_name: "usage_entitlements", count: 0 }],
      }),
      transaction: vi.fn(),
      check: databaseHealthy
        ? vi.fn().mockResolvedValue(undefined)
        : vi.fn().mockRejectedValue(new Error("postgres_unavailable")),
      close: vi.fn().mockResolvedValue(undefined),
    },
    jobs: {
      dispatch: vi.fn(),
      check: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    },
    objectStore: {
      put: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      check: vi.fn().mockResolvedValue(undefined),
    },
    inference: {
      generate: vi.fn(),
      check: vi.fn().mockResolvedValue(undefined),
    },
    email: {
      configured: false,
      send: vi.fn(),
      check: vi.fn().mockResolvedValue(undefined),
    },
    operatorIdentity: {
      authenticate: vi.fn(),
      check: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("portable Hono app", () => {
  it("provides an unconditional liveness endpoint", async () => {
    const response = await createApp(runtime(false)).request("/health/live");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "belki-portable-web",
    });
  });

  it("fails readiness when a required service is unavailable", async () => {
    const response = await createApp(runtime(false)).request("/health/ready");
    expect(response.status).toBe(503);
    const payload = await response.json() as {
      ready: boolean;
      checks: { postgres: { ok: boolean; detail?: string } };
    };
    expect(payload.ready).toBe(false);
    expect(payload.checks.postgres).toMatchObject({
      ok: false,
      detail: "postgres_unavailable",
    });
  });

  it("preserves the public status response contract", async () => {
    const response = await createApp(runtime()).request("/api/v1/status");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        setupRequired: true,
        emailDeliveryConfigured: false,
      },
    });
  });
});
