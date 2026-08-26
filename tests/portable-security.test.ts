import { describe, expect, it } from "vitest";
import { ProxyOperatorIdentity } from "../src/portable/adapters/operator-identity";
import { loadConfig } from "../src/portable/config";
import { hashPassword, verifyPassword } from "../src/portable/security/crypto";

const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://belki:secret@localhost:5432/belki",
  APP_BASE_URL: "http://localhost:3000",
  APP_CRYPTO_KEY: "a".repeat(32),
  BOOTSTRAP_TOKEN: "b".repeat(32),
  S3_BUCKET: "belki-evidence",
  DEPLOYMENT_MODE: "managed",
  OIDC_TRUST_SECRET: "c".repeat(32),
});

describe("portable security adapters", () => {
  it("preserves password hash compatibility", async () => {
    const credential = await hashPassword("a sufficiently long password");
    await expect(verifyPassword(
      "a sufficiently long password",
      credential.salt,
      credential.iterations,
      credential.passwordHash,
    )).resolves.toBe(true);
    await expect(verifyPassword(
      "wrong password",
      credential.salt,
      credential.iterations,
      credential.passwordHash,
    )).resolves.toBe(false);
  });

  it("accepts proxy identity only with the shared trust secret", async () => {
    const identity = new ProxyOperatorIdentity(config);
    const headers = new Headers({
      "x-auth-request-email": "Operator@Example.com",
      "x-belki-proxy-secret": "c".repeat(32),
    });
    await expect(identity.authenticate(headers)).resolves.toEqual({
      email: "operator@example.com",
    });
  });

  it("rejects a spoofed identity header sent without proxy trust", async () => {
    const identity = new ProxyOperatorIdentity(config);
    await expect(identity.authenticate(new Headers({
      "x-auth-request-email": "operator@example.com",
    }))).rejects.toThrow("untrusted_operator_identity_headers");
  });
});
