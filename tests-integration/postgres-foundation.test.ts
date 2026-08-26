import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/portable/app";
import { loadConfig } from "../src/portable/config";
import { PostgresDatabase } from "../src/portable/database";
import { migrate } from "../src/portable/migrate";
import type { PortableRuntime } from "../src/portable/runtime";
import { PostgresUsageRepository, UsageGateError } from "../src/portable/usage/repository";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl ?? "postgresql://unused:unused@localhost:5432/unused",
  APP_BASE_URL: "http://localhost:3000",
  APP_CRYPTO_KEY: "a".repeat(32),
  BOOTSTRAP_TOKEN: "b".repeat(32),
  S3_BUCKET: "belki-evidence",
});

integration("PostgreSQL portable foundation", () => {
  const database = new PostgresDatabase(config);
  const usage = new PostgresUsageRepository(database);

  beforeAll(async () => migrate(config));
  beforeEach(async () => {
    await database.query(
      `TRUNCATE TABLE
        audit_log, sessions, usage_resource_claims, usage_reservations,
        usage_entitlements, billing_accounts, projects, memberships,
        password_credentials, platform_operators, users, workspaces
       RESTART IDENTITY CASCADE`,
    );
  });
  afterAll(async () => database.close());

  it("boots a fresh installation through the unchanged setup contract", async () => {
    const runtime = {
      config,
      database,
      email: {
        configured: false,
        send: () => Promise.reject(new Error("disabled")),
        check: () => Promise.resolve(),
      },
    } as unknown as PortableRuntime;
    const app = createApp(runtime);
    const before = await app.request("/api/v1/status");
    await expect(before.json()).resolves.toMatchObject({ data: { setupRequired: true } });

    const setup = await app.request("/api/v1/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bootstrapToken: config.BOOTSTRAP_TOKEN,
        workspaceName: "Portable Belki",
        displayName: "Owner",
        email: "owner@example.com",
        password: "a secure portable password",
        timezone: "UTC",
        monthlyRunCap: 1000,
      }),
    });
    expect(setup.status, await setup.clone().text()).toBe(201);
    expect(setup.headers.get("set-cookie")).toContain("ai_tracker_session=");

    const setCookie = setup.headers.get("set-cookie") ?? "";
    const sessionCookie = cookieValue(setCookie, "ai_tracker_session");
    const csrfCookie = cookieValue(setCookie, "ai_tracker_csrf");
    expect(sessionCookie).toBeTruthy();
    expect(csrfCookie).toBeTruthy();

    const authenticatedHeaders = {
      "content-type": "application/json",
      cookie: `ai_tracker_session=${sessionCookie}; ai_tracker_csrf=${csrfCookie}`,
      "x-csrf-token": csrfCookie,
    };
    const project = await app.request("/api/v1/projects", {
      method: "POST",
      headers: authenticatedHeaders,
      body: JSON.stringify({
        name: "Portable visibility",
        primaryDomain: "https://www.example.com/landing",
        ownedBrandName: "Example",
        ownedBrandAliases: ["Example Inc"],
        competitorBrands: [],
        htmlCaptureEnabled: false,
      }),
    });
    expect(project.status).toBe(201);
    const projectPayload = await project.json() as { data: { id: string } };

    const prompts = await app.request(
      `/api/v1/projects/${projectPayload.data.id}/queries/bulk`,
      {
        method: "POST",
        headers: authenticatedHeaders,
        body: JSON.stringify({
          queryTexts: ["What is Example?", "What is Example?", "Example alternatives"],
          locationCode: 2840,
          languageCode: "en",
          forceWebSearch: true,
          schedule: { cadence: "daily", time: "09:00", timezone: "UTC" },
          tags: ["Onboarding"],
        }),
      },
    );
    expect(prompts.status).toBe(201);
    await expect(prompts.json()).resolves.toMatchObject({
      data: { createdCount: 2, skippedCount: 1 },
    });

    const promptPage = await app.request(
      `/api/v1/analytics/prompts?projectId=${projectPayload.data.id}`,
      { headers: { cookie: authenticatedHeaders.cookie } },
    );
    expect(promptPage.status).toBe(200);
    const promptPayload = await promptPage.json() as {
      page: { total: number };
      data: Array<{ latestSnapshotId: string | null; tags: Array<{ name: string }> }>;
    };
    expect(promptPayload.page.total).toBe(2);
    expect(promptPayload.data).toHaveLength(2);
    for (const prompt of promptPayload.data) {
      expect(prompt).toMatchObject({
        latestSnapshotId: null,
        tags: [{ name: "Onboarding" }],
      });
    }

    const session = await app.request("/api/v1/auth/session", {
      headers: { cookie: authenticatedHeaders.cookie },
    });
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({
      data: { projects: [{ id: projectPayload.data.id, query_count: 2 }] },
    });

    const after = await app.request("/api/v1/status");
    await expect(after.json()).resolves.toMatchObject({ data: { setupRequired: false } });
  });

  it("serializes concurrent reservations so allowance cannot be exceeded", async () => {
    const workspaceId = randomUUID();
    await database.query(
      `INSERT INTO workspaces (id, name, public_base_url)
       VALUES ($1, 'Concurrency', 'http://localhost:3000')`,
      [workspaceId],
    );
    const now = new Date();
    await usage.setEntitlement(workspaceId, {
      planKey: "self_hosted",
      subscriptionStatus: "active",
      workspaceStatus: "active",
      allowance: 1,
      projectLimit: 1,
      promptLimit: 1,
      sourceLimit: 4,
      cycleStartedAt: new Date(now.getTime() - 60_000).toISOString(),
      cycleEndsAt: new Date(now.getTime() + 60_000).toISOString(),
      readOnlyUntil: null,
    });
    const results = await Promise.allSettled([
      usage.reserve(workspaceId, {
        reservationId: randomUUID(),
        sku: "llm_standard",
        units: 1,
        resourceType: "crawl_job",
        resourceId: randomUUID(),
      }),
      usage.reserve(workspaceId, {
        reservationId: randomUUID(),
        sku: "llm_standard",
        units: 1,
        resourceType: "crawl_job",
        resourceId: randomUUID(),
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.status === "rejected" && rejection.reason).toBeInstanceOf(UsageGateError);
  });

  it("makes resource claims idempotent", async () => {
    const workspaceId = randomUUID();
    await database.query(
      `INSERT INTO workspaces (id, name, public_base_url)
       VALUES ($1, 'Claims', 'http://localhost:3000')`,
      [workspaceId],
    );
    const now = new Date();
    await usage.setEntitlement(workspaceId, {
      planKey: "self_hosted",
      subscriptionStatus: "active",
      workspaceStatus: "active",
      allowance: 100,
      projectLimit: 1,
      promptLimit: 1,
      sourceLimit: 4,
      cycleStartedAt: new Date(now.getTime() - 60_000).toISOString(),
      cycleEndsAt: new Date(now.getTime() + 60_000).toISOString(),
      readOnlyUntil: null,
    });
    const claimId = randomUUID();
    const projectId = randomUUID();
    await expect(usage.claimProject(workspaceId, claimId, projectId)).resolves.toMatchObject({
      projectCount: 1,
    });
    await expect(usage.claimProject(workspaceId, claimId, projectId)).resolves.toMatchObject({
      projectCount: 1,
    });
  });
});

function cookieValue(setCookie: string, name: string): string {
  return new RegExp(`(?:^|,\\s*)${name}=([^;]+)`, "u").exec(setCookie)?.[1] ?? "";
}
