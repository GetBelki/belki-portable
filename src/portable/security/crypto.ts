import { createHash, pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derivePassword = promisify(pbkdf2);
const PASSWORD_ITERATIONS = 100_000;

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function randomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export async function hashPassword(password: string): Promise<{
  algorithm: "pbkdf2-sha256";
  iterations: number;
  salt: string;
  passwordHash: string;
}> {
  const salt = randomBytes(16);
  const passwordHash = await derivePassword(password, salt, PASSWORD_ITERATIONS, 32, "sha256");
  return {
    algorithm: "pbkdf2-sha256",
    iterations: PASSWORD_ITERATIONS,
    salt: salt.toString("base64url"),
    passwordHash: passwordHash.toString("base64url"),
  };
}

export async function verifyPassword(
  password: string,
  salt: string,
  iterations: number,
  expectedHash: string,
): Promise<boolean> {
  const expected = decode(expectedHash);
  const actual = await derivePassword(password, decode(salt), iterations, expected.byteLength, "sha256");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

export function timingSafeTextEqual(left: string, right: string): boolean {
  const leftHash = decode(sha256(left));
  const rightHash = decode(sha256(right));
  return timingSafeEqual(leftHash, rightHash);
}
