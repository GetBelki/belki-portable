import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiErrorShape } from "../shared/contracts";
import { UsageGateError } from "./usage/repository";

export class ApiError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function requestId(): string {
  return crypto.randomUUID();
}

export function errorResponse(context: Context, error: unknown): Response {
  const id = context.get("requestId") as string | undefined ?? requestId();
  if (error instanceof ApiError) {
    const body: ApiErrorShape = {
      error: {
        code: error.code,
        message: error.message,
        requestId: id,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
    return context.json(body, error.status);
  }
  if (error instanceof UsageGateError) {
    const status = error.code === "payment_required"
      ? 402
      : error.code === "workspace_read_only"
        ? 403
        : error.code.startsWith("invalid_")
          ? 400
          : error.code === "entitlement_not_configured" || error.code === "billing_cycle_inactive"
            ? 503
            : 409;
    return context.json<ApiErrorShape>({
      error: {
        code: error.code,
        message: usageErrorMessage(error.code),
        requestId: id,
      },
    }, status);
  }
  if (isPostgresUniqueViolation(error)) {
    const queryConflict = error.constraint === "tracked_queries_active_text_idx";
    return context.json<ApiErrorShape>({
      error: {
        code: queryConflict ? "query_already_exists" : "resource_conflict",
        message: queryConflict
          ? "This prompt is already tracked."
          : "A resource with these values already exists.",
        requestId: id,
      },
    }, 409);
  }
  console.error(JSON.stringify({
    level: "error",
    message: "request_failed",
    requestId: id,
    error: error instanceof Error ? error.message : String(error),
  }));
  return context.json<ApiErrorShape>({
    error: {
      code: "internal_error",
      message: "An unexpected error occurred.",
      requestId: id,
    },
  }, 500);
}

function isPostgresUniqueViolation(
  error: unknown,
): error is { code: "23505"; constraint?: string } {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "23505";
}

function usageErrorMessage(code: string): string {
  switch (code) {
    case "project_limit": return "The workspace project limit has been reached.";
    case "prompt_limit": return "The workspace prompt limit has been reached.";
    case "usage_limit": return "The workspace usage allowance has been reached.";
    case "payment_required": return "An active subscription is required.";
    case "workspace_read_only": return "This workspace is read-only.";
    case "billing_cycle_inactive": return "The workspace billing cycle is not active.";
    case "entitlement_not_configured": return "Workspace usage entitlements are not configured.";
    default: return "The usage operation could not be completed.";
  }
}
