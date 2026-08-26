import type {
  PlanKey,
  SubscriptionStatus,
  UsageReservationStatus,
  UsageSku,
  WorkspaceStatus,
} from "../../shared/contracts";
import type { Database, QueryExecutor } from "../contracts";

export interface UsageEntitlement {
  planKey: PlanKey;
  subscriptionStatus: SubscriptionStatus;
  workspaceStatus: WorkspaceStatus;
  allowance: number;
  projectLimit: number;
  promptLimit: number;
  sourceLimit: number;
  cycleStartedAt: string;
  cycleEndsAt: string;
  readOnlyUntil: string | null;
}

export interface UsageReservationInput {
  reservationId: string;
  sku: UsageSku;
  units: number;
  resourceType: string;
  resourceId: string;
}

export interface UsageReservationResult {
  reservationId: string;
  status: UsageReservationStatus;
  units: number;
  used: number;
  reserved: number;
  remaining: number;
  cycleStartedAt: string;
}

export interface UsageSummary extends UsageEntitlement {
  committed: number;
  reserved: number;
  remaining: number;
  projectCount: number;
  promptCount: number;
}

type ResourceKind = "project" | "prompt";

interface EntitlementRow {
  plan_key: PlanKey;
  subscription_status: SubscriptionStatus;
  workspace_status: WorkspaceStatus;
  allowance: string | number;
  project_limit: string | number;
  prompt_limit: string | number;
  source_limit: string | number;
  cycle_started_at: Date;
  cycle_ends_at: Date;
  read_only_until: Date | null;
}

interface ReservationRow {
  reservation_id: string;
  status: UsageReservationStatus;
  units: string | number;
  cycle_started_at: Date;
}

export class UsageGateError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export class PostgresUsageRepository {
  constructor(private readonly database: Database) {}

  async setEntitlement(workspaceId: string, input: UsageEntitlement): Promise<UsageSummary> {
    await this.database.transaction(async (transaction) => {
      await this.lock(transaction, workspaceId);
      await transaction.query(
        `INSERT INTO usage_entitlements (
          workspace_id, plan_key, subscription_status, workspace_status, allowance,
          project_limit, prompt_limit, source_limit, cycle_started_at, cycle_ends_at,
          read_only_until, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
        ON CONFLICT (workspace_id) DO UPDATE SET
          plan_key = excluded.plan_key,
          subscription_status = excluded.subscription_status,
          workspace_status = excluded.workspace_status,
          allowance = excluded.allowance,
          project_limit = excluded.project_limit,
          prompt_limit = excluded.prompt_limit,
          source_limit = excluded.source_limit,
          cycle_started_at = excluded.cycle_started_at,
          cycle_ends_at = excluded.cycle_ends_at,
          read_only_until = excluded.read_only_until,
          updated_at = now()`,
        [
          workspaceId,
          input.planKey,
          input.subscriptionStatus,
          input.workspaceStatus,
          input.allowance,
          input.projectLimit,
          input.promptLimit,
          input.sourceLimit,
          input.cycleStartedAt,
          input.cycleEndsAt,
          input.readOnlyUntil,
        ],
      );
    });
    return this.summary(workspaceId);
  }

  reserve(workspaceId: string, input: UsageReservationInput): Promise<UsageReservationResult> {
    if (!Number.isInteger(input.units) || input.units <= 0) {
      return Promise.reject(new UsageGateError("invalid_usage_units"));
    }
    return this.database.transaction(async (transaction) => {
      await this.lock(transaction, workspaceId);
      const entitlement = await this.requireEntitlement(transaction, workspaceId);
      this.assertWritable(entitlement);
      const existing = await transaction.query<ReservationRow>(
        `SELECT reservation_id, status, units, cycle_started_at
         FROM usage_reservations WHERE workspace_id = $1 AND reservation_id = $2`,
        [workspaceId, input.reservationId],
      );
      const row = existing.rows[0];
      if (row) {
        if (
          Number(row.units) !== input.units ||
          iso(row.cycle_started_at) !== iso(entitlement.cycle_started_at)
        ) {
          throw new UsageGateError("reservation_conflict");
        }
        return this.reservationResult(transaction, workspaceId, row, entitlement);
      }
      const totals = await this.totals(transaction, workspaceId, entitlement.cycle_started_at);
      if (totals.committed + totals.reserved + input.units > Number(entitlement.allowance)) {
        throw new UsageGateError("usage_limit");
      }
      await transaction.query(
        `INSERT INTO usage_reservations (
          workspace_id, reservation_id, sku, units, resource_type, resource_id,
          status, cycle_started_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'reserved', $7, now(), now())`,
        [
          workspaceId,
          input.reservationId,
          input.sku,
          input.units,
          input.resourceType,
          input.resourceId,
          entitlement.cycle_started_at,
        ],
      );
      return this.reservationResult(
        transaction,
        workspaceId,
        {
          reservation_id: input.reservationId,
          status: "reserved",
          units: input.units,
          cycle_started_at: entitlement.cycle_started_at,
        },
        entitlement,
      );
    });
  }

  commit(workspaceId: string, reservationId: string): Promise<UsageReservationResult> {
    return this.transition(workspaceId, reservationId, "committed");
  }

  release(workspaceId: string, reservationId: string): Promise<UsageReservationResult> {
    return this.transition(workspaceId, reservationId, "released");
  }

  claimProject(workspaceId: string, claimId: string, projectId: string): Promise<UsageSummary> {
    return this.claimResource(workspaceId, "project", claimId, projectId);
  }

  claimPrompts(
    workspaceId: string,
    claimId: string,
    promptIds: readonly string[],
  ): Promise<UsageSummary> {
    if (promptIds.length === 0 || new Set(promptIds).size !== promptIds.length) {
      return Promise.reject(new UsageGateError("invalid_prompt_claim"));
    }
    return this.database.transaction(async (transaction) => {
      await this.lock(transaction, workspaceId);
      const entitlement = await this.requireEntitlement(transaction, workspaceId);
      this.assertWritable(entitlement);
      const existing = await transaction.query<{
        resource_id: string;
        status: "claimed" | "released";
      }>(
        `SELECT resource_id, status FROM usage_resource_claims
         WHERE workspace_id = $1 AND claim_id = $2 AND resource_kind = 'prompt'
         ORDER BY resource_id`,
        [workspaceId, claimId],
      );
      if (existing.rows.length > 0) {
        const existingIds = existing.rows.map((row) => row.resource_id).sort();
        const requestedIds = [...promptIds].sort();
        if (
          existing.rows.some((row) => row.status !== "claimed") ||
          JSON.stringify(existingIds) !== JSON.stringify(requestedIds)
        ) {
          throw new UsageGateError("resource_claim_conflict");
        }
        return this.summaryWith(transaction, workspaceId, entitlement);
      }
      const counts = await this.resourceCounts(transaction, workspaceId);
      if (counts.prompt + promptIds.length > Number(entitlement.prompt_limit)) {
        throw new UsageGateError("prompt_limit");
      }
      for (const promptId of promptIds) {
        await transaction.query(
          `INSERT INTO usage_resource_claims (
            workspace_id, claim_id, resource_kind, resource_id, status, created_at, updated_at
          ) VALUES ($1, $2, 'prompt', $3, 'claimed', now(), now())`,
          [workspaceId, claimId, promptId],
        );
      }
      return this.summaryWith(transaction, workspaceId, entitlement);
    });
  }

  async releaseResourceClaim(workspaceId: string, claimId: string): Promise<UsageSummary> {
    return this.database.transaction(async (transaction) => {
      await this.lock(transaction, workspaceId);
      const entitlement = await this.requireEntitlement(transaction, workspaceId);
      const result = await transaction.query(
        `UPDATE usage_resource_claims SET status = 'released', updated_at = now()
         WHERE workspace_id = $1 AND claim_id = $2 AND status = 'claimed'`,
        [workspaceId, claimId],
      );
      if (result.rowCount === 0) {
        const existing = await transaction.query(
          "SELECT 1 FROM usage_resource_claims WHERE workspace_id = $1 AND claim_id = $2",
          [workspaceId, claimId],
        );
        if (existing.rowCount === 0) throw new UsageGateError("resource_claim_not_found");
      }
      return this.summaryWith(transaction, workspaceId, entitlement);
    });
  }

  async releaseResources(
    workspaceId: string,
    kind: ResourceKind,
    resourceIds: readonly string[],
  ): Promise<UsageSummary> {
    const uniqueIds = [...new Set(resourceIds)];
    if (uniqueIds.length === 0) return this.summary(workspaceId);
    return this.database.transaction(async (transaction) => {
      await this.lock(transaction, workspaceId);
      const entitlement = await this.requireEntitlement(transaction, workspaceId);
      await transaction.query(
        `UPDATE usage_resource_claims SET status = 'released', updated_at = now()
         WHERE workspace_id = $1 AND resource_kind = $2
           AND resource_id = ANY($3::uuid[]) AND status = 'claimed'`,
        [workspaceId, kind, uniqueIds],
      );
      return this.summaryWith(transaction, workspaceId, entitlement);
    });
  }

  summary(workspaceId: string): Promise<UsageSummary> {
    return this.database.transaction(async (transaction) => {
      await this.lock(transaction, workspaceId);
      const entitlement = await this.requireEntitlement(transaction, workspaceId);
      return this.summaryWith(transaction, workspaceId, entitlement);
    });
  }

  private claimResource(
    workspaceId: string,
    kind: ResourceKind,
    claimId: string,
    resourceId: string,
  ): Promise<UsageSummary> {
    return this.database.transaction(async (transaction) => {
      await this.lock(transaction, workspaceId);
      const entitlement = await this.requireEntitlement(transaction, workspaceId);
      this.assertWritable(entitlement);
      const existing = await transaction.query<{
        resource_kind: ResourceKind;
        resource_id: string;
        status: "claimed" | "released";
      }>(
        `SELECT resource_kind, resource_id, status FROM usage_resource_claims
         WHERE workspace_id = $1 AND claim_id = $2`,
        [workspaceId, claimId],
      );
      const row = existing.rows[0];
      if (row) {
        if (row.resource_kind !== kind || row.resource_id !== resourceId || row.status !== "claimed") {
          throw new UsageGateError("resource_claim_conflict");
        }
        return this.summaryWith(transaction, workspaceId, entitlement);
      }
      const counts = await this.resourceCounts(transaction, workspaceId);
      const limit = kind === "project"
        ? Number(entitlement.project_limit)
        : Number(entitlement.prompt_limit);
      if (counts[kind] + 1 > limit) throw new UsageGateError(`${kind}_limit`);
      await transaction.query(
        `INSERT INTO usage_resource_claims (
          workspace_id, claim_id, resource_kind, resource_id, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'claimed', now(), now())`,
        [workspaceId, claimId, kind, resourceId],
      );
      return this.summaryWith(transaction, workspaceId, entitlement);
    });
  }

  private transition(
    workspaceId: string,
    reservationId: string,
    target: "committed" | "released",
  ): Promise<UsageReservationResult> {
    return this.database.transaction(async (transaction) => {
      await this.lock(transaction, workspaceId);
      const entitlement = await this.requireEntitlement(transaction, workspaceId);
      const result = await transaction.query<ReservationRow>(
        `SELECT reservation_id, status, units, cycle_started_at
         FROM usage_reservations WHERE workspace_id = $1 AND reservation_id = $2 FOR UPDATE`,
        [workspaceId, reservationId],
      );
      const row = result.rows[0];
      if (!row) throw new UsageGateError("reservation_not_found");
      if (row.status === "reserved") {
        await transaction.query(
          `UPDATE usage_reservations SET status = $3, updated_at = now()
           WHERE workspace_id = $1 AND reservation_id = $2`,
          [workspaceId, reservationId, target],
        );
        row.status = target;
      } else if (row.status !== target) {
        throw new UsageGateError("reservation_already_finalized");
      }
      return this.reservationResult(transaction, workspaceId, row, entitlement);
    });
  }

  private async reservationResult(
    transaction: QueryExecutor,
    workspaceId: string,
    row: ReservationRow,
    entitlement: EntitlementRow,
  ): Promise<UsageReservationResult> {
    const totals = await this.totals(transaction, workspaceId, row.cycle_started_at);
    return {
      reservationId: row.reservation_id,
      status: row.status,
      units: Number(row.units),
      used: totals.committed,
      reserved: totals.reserved,
      remaining: Math.max(0, Number(entitlement.allowance) - totals.committed - totals.reserved),
      cycleStartedAt: iso(row.cycle_started_at),
    };
  }

  private async summaryWith(
    transaction: QueryExecutor,
    workspaceId: string,
    entitlement: EntitlementRow,
  ): Promise<UsageSummary> {
    const [totals, counts] = await Promise.all([
      this.totals(transaction, workspaceId, entitlement.cycle_started_at),
      this.resourceCounts(transaction, workspaceId),
    ]);
    return {
      planKey: entitlement.plan_key,
      subscriptionStatus: entitlement.subscription_status,
      workspaceStatus: entitlement.workspace_status,
      allowance: Number(entitlement.allowance),
      projectLimit: Number(entitlement.project_limit),
      promptLimit: Number(entitlement.prompt_limit),
      sourceLimit: Number(entitlement.source_limit),
      cycleStartedAt: iso(entitlement.cycle_started_at),
      cycleEndsAt: iso(entitlement.cycle_ends_at),
      readOnlyUntil: entitlement.read_only_until ? iso(entitlement.read_only_until) : null,
      projectCount: counts.project,
      promptCount: counts.prompt,
      committed: totals.committed,
      reserved: totals.reserved,
      remaining: Math.max(
        0,
        Number(entitlement.allowance) - totals.committed - totals.reserved,
      ),
    };
  }

  private async requireEntitlement(
    transaction: QueryExecutor,
    workspaceId: string,
  ): Promise<EntitlementRow> {
    const result = await transaction.query<EntitlementRow & import("pg").QueryResultRow>(
      `SELECT plan_key, subscription_status, workspace_status, allowance, project_limit,
        prompt_limit, source_limit, cycle_started_at, cycle_ends_at, read_only_until
       FROM usage_entitlements WHERE workspace_id = $1 FOR UPDATE`,
      [workspaceId],
    );
    const row = result.rows[0];
    if (!row) throw new UsageGateError("entitlement_not_configured");
    return row;
  }

  private assertWritable(entitlement: EntitlementRow): void {
    if (entitlement.workspace_status !== "active") throw new UsageGateError("workspace_read_only");
    if (!(["active", "trialing"] as SubscriptionStatus[]).includes(entitlement.subscription_status)) {
      throw new UsageGateError("payment_required");
    }
    const now = Date.now();
    if (
      entitlement.cycle_started_at.getTime() > now ||
      entitlement.cycle_ends_at.getTime() <= now
    ) {
      throw new UsageGateError("billing_cycle_inactive");
    }
  }

  private async totals(
    transaction: QueryExecutor,
    workspaceId: string,
    cycleStartedAt: Date,
  ): Promise<{ committed: number; reserved: number }> {
    const result = await transaction.query<{
      committed: string | number;
      reserved: string | number;
    } & import("pg").QueryResultRow>(
      `SELECT
        COALESCE(SUM(units) FILTER (WHERE status = 'committed'), 0) AS committed,
        COALESCE(SUM(units) FILTER (WHERE status = 'reserved'), 0) AS reserved
       FROM usage_reservations WHERE workspace_id = $1 AND cycle_started_at = $2`,
      [workspaceId, cycleStartedAt],
    );
    return {
      committed: Number(result.rows[0]?.committed ?? 0),
      reserved: Number(result.rows[0]?.reserved ?? 0),
    };
  }

  private async resourceCounts(
    transaction: QueryExecutor,
    workspaceId: string,
  ): Promise<Record<ResourceKind, number>> {
    const result = await transaction.query<{
      project_count: string | number;
      prompt_count: string | number;
    } & import("pg").QueryResultRow>(
      `SELECT
        COUNT(*) FILTER (WHERE resource_kind = 'project') AS project_count,
        COUNT(*) FILTER (WHERE resource_kind = 'prompt') AS prompt_count
       FROM usage_resource_claims WHERE workspace_id = $1 AND status = 'claimed'`,
      [workspaceId],
    );
    return {
      project: Number(result.rows[0]?.project_count ?? 0),
      prompt: Number(result.rows[0]?.prompt_count ?? 0),
    };
  }

  private async lock(transaction: QueryExecutor, workspaceId: string): Promise<void> {
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`belki:usage:${workspaceId}`],
    );
  }
}
