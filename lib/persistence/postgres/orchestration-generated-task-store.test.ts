import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { AuthorizationConsumptionRecord } from "@/lib/authorization/grants";
import type { GeneratedTask } from "@/lib/planning/task-generator";
import {
  PostgresOrchestrationGeneratedTaskStore
} from "@/lib/persistence/postgres/orchestration-generated-task-store";

function taskFixture(): GeneratedTask {
  const scope = {
    userId: "owner-a",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging" as const
  };
  const consumptionBase = {
    id: "authorization-consumption:grant-step-1",
    grantId: "grant-step-1",
    grantHash: "a".repeat(64),
    consumerType: "task" as const,
    consumerId: "task-run-1-step-1",
    scope,
    planHash: "b".repeat(64),
    stepHash: "c".repeat(64),
    consumedAt: "2026-09-28T16:00:00.000Z"
  };
  const authorizationConsumption: AuthorizationConsumptionRecord = {
    ...consumptionBase,
    consumptionHash: sha256Hex(consumptionBase)
  };

  return {
    id: "task-run-1-step-1",
    logicalKey: "portfolio-a:company-a:owner-request:intent-1:fingerprint",
    planId: "plan-1",
    planStepId: "step-1",
    scope: {
      ...scope,
      dataClass: "internal"
    },
    source: {
      type: "owner-request",
      referenceId: "intent-1"
    },
    reason: "Inspect the repository",
    evidenceIds: [],
    priority: "normal",
    capabilityRequirements: ["repository.inspect"],
    operations: [{
      capability: "repository.inspect",
      input: {
        companyId: "company-a",
        repository: "DMART19/GetDone",
        ref: "main"
      }
    }],
    authorizationLineage: [{
      kind: "auto-policy",
      referenceId: "grant-step-1",
      grantedAt: "2026-09-28T15:59:59.000Z",
      actorId: "getdone-policy"
    }],
    authorizationGrantId: "grant-step-1",
    authorizationGrantHash: "a".repeat(64),
    authorizationConsumption,
    validationReceiptId: "receipt-1",
    validationReceiptHash: "d".repeat(64),
    policySnapshotId: "policy-1",
    policySnapshotHash: "e".repeat(64),
    dependsOnLogicalKeys: [],
    preconditions: [],
    resourceRequirements: {
      execution: {
        environment: "staging",
        priority: 50,
        checkpointable: true,
        retryable: true
      },
      reliability: {
        minimumTier: "standard",
        fallbackRequired: false,
        maxInterruptionClass: "brief"
      },
      data: {
        classification: "internal",
        customerData: false,
        allowedRegions: ["us-west"]
      },
      economics: {
        maxJobCostCents: 20
      },
      credentialBindingRequired: false
    },
    verificationRequirements: [{
      id: "verify-step-1",
      description: "Validate inspection output",
      kind: "capability-output",
      required: true
    }],
    rollback: {
      strategy: "none",
      cancellationAllowed: true
    },
    estimatedCostCents: 20,
    createdAt: "2026-09-28T16:00:00.000Z"
  };
}

class GeneratedTaskDb {
  entity: { payload: { taskHash: string; task: GeneratedTask } } | null = null;
  idempotency: {
    key: string;
    fingerprint: string;
    status: "IN_PROGRESS" | "COMPLETED";
    created_at: string;
    completed_at: string | null;
    failed_at: null;
    result: GeneratedTask | null;
    error_code: null;
  } | null = null;
  authorizationConsumptionInserts = 0;

  async query(sql: string, values: unknown[] = []) {
    const normalized = sql.replace(/\\s+/g, " ").trim();

    if (normalized.startsWith("INSERT INTO idempotency_records")) {
      if (this.idempotency) return { rows: [], rowCount: 0 };
      this.idempotency = {
        key: String(values[0]),
        fingerprint: String(values[1]),
        status: "IN_PROGRESS",
        created_at: String(values[2]),
        completed_at: null,
        failed_at: null,
        result: null,
        error_code: null
      };
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("SELECT * FROM idempotency_records")) {
      return {
        rows: this.idempotency ? [this.idempotency] : [],
        rowCount: this.idempotency ? 1 : 0
      };
    }

    if (normalized.startsWith("UPDATE idempotency_records") && normalized.includes("COMPLETED")) {
      if (!this.idempotency) return { rows: [], rowCount: 0 };
      this.idempotency = {
        ...this.idempotency,
        status: "COMPLETED",
        completed_at: String(values[2]),
        result: JSON.parse(String(values[3])) as GeneratedTask
      };
      return { rows: [this.idempotency], rowCount: 1 };
    }

    if (normalized.startsWith("INSERT INTO control_plane_entities")) {
      if (this.entity) {
        const error = Object.assign(new Error("duplicate"), { code: "23505" });
        throw error;
      }
      this.entity = {
        payload: JSON.parse(String(values[5])) as {
          taskHash: string;
          task: GeneratedTask;
        }
      };
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("INSERT INTO authorization_consumptions")) {
      this.authorizationConsumptionInserts += 1;
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("SELECT payload FROM control_plane_entities")) {
      return {
        rows: this.entity ? [this.entity] : [],
        rowCount: this.entity ? 1 : 0
      };
    }

    throw new Error("Unexpected SQL: " + normalized);
  }

  async transaction<T>(operation: (client: never) => Promise<T>) {
    return operation(this as never);
  }
}

describe("PostgresOrchestrationGeneratedTaskStore", () => {
  it("atomically persists the logical Task claim and single-use authorization consumption", async () => {
    const db = new GeneratedTaskDb();
    const store = new PostgresOrchestrationGeneratedTaskStore(
      db as never,
      {
        runId: "run-1",
        portfolioId: "portfolio-a",
        companyId: "company-a"
      }
    );
    const task = taskFixture();

    const first = await store.claim(task, task.authorizationConsumption);
    const replay = await store.claim(task, task.authorizationConsumption);

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.task).toEqual(task);
    expect(db.authorizationConsumptionInserts).toBe(1);
    await expect(store.get(task.id)).resolves.toEqual(task);
  });

  it("fails closed when a logical Task replay changes authoritative content", async () => {
    const db = new GeneratedTaskDb();
    const store = new PostgresOrchestrationGeneratedTaskStore(
      db as never,
      {
        runId: "run-1",
        portfolioId: "portfolio-a",
        companyId: "company-a"
      }
    );
    const task = taskFixture();
    await store.claim(task, task.authorizationConsumption);

    await expect(store.claim({
      ...task,
      reason: "Different work under the same logical identity"
    }, task.authorizationConsumption)).rejects.toThrow(/different authoritative content/i);
  });

  it("rejects cross-company Task claims before persistence", async () => {
    const db = new GeneratedTaskDb();
    const store = new PostgresOrchestrationGeneratedTaskStore(
      db as never,
      {
        runId: "run-1",
        portfolioId: "portfolio-a",
        companyId: "company-b"
      }
    );
    const task = taskFixture();

    await expect(
      store.claim(task, task.authorizationConsumption)
    ).rejects.toThrow(/outside the bound orchestration tenant/i);
    expect(db.entity).toBeNull();
  });
});
