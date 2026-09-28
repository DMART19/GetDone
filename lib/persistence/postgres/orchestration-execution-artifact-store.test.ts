import { describe, expect, it } from "vitest";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import {
  createValidationReceiptExecutionArtifact,
  type OrchestrationExecutionArtifact
} from "@/lib/orchestration/execution-artifacts";
import type {
  PostgresTransactionalDatabase,
  SqlQueryable
} from "@/lib/persistence/postgres/client";
import { PostgresOrchestrationExecutionArtifactStore } from "@/lib/persistence/postgres/orchestration-execution-artifact-store";
import { receiptFor } from "@/lib/planning/test-security-fixture";
import { validPlan } from "@/lib/planning/test-fixture";
import { hashPlan } from "@/lib/planning/plan-hash";

interface FakeResponse {
  rows?: QueryResultRow[];
  rowCount?: number;
}

class QueueSql implements SqlQueryable {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  constructor(private readonly responses: FakeResponse[] = []) {}
  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<R>> {
    this.calls.push({ text, values });
    const response = this.responses.shift() ?? { rows: [], rowCount: 1 };
    return {
      command: "",
      rowCount: response.rowCount ?? response.rows?.length ?? 0,
      oid: 0,
      fields: [],
      rows: (response.rows ?? []) as R[]
    };
  }
}

function db(sql: QueueSql): PostgresTransactionalDatabase {
  return {
    query: sql.query.bind(sql),
    async transaction<T>(operation: (client: PoolClient) => Promise<T>) {
      return operation(sql as unknown as PoolClient);
    }
  };
}

function run(): OrchestrationRun {
  return Object.freeze({
    id: "run-1",
    correlationId: "corr-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging",
    authorityUserId: "user-a",
    initiatingActor: Object.freeze({ type: "user" as const, id: "user-a" }),
    source: Object.freeze({ kind: "owner-intent" as const, ownerIntentId: "intent-1" }),
    state: "authorized",
    attempt: 1,
    version: 7,
    availableAt: "2026-09-20T18:30:00Z",
    createdAt: "2026-09-20T18:30:00Z",
    updatedAt: "2026-09-20T18:30:00Z"
  });
}

function artifact(): OrchestrationExecutionArtifact {
  const plan = validPlan();
  const value = createValidationReceiptExecutionArtifact({
    id: "execution-artifact-1",
    runId: run().id,
    correlationId: run().correlationId,
    planHash: hashPlan(plan),
    receipt: receiptFor(plan),
    createdAt: "2026-09-20T18:30:00Z"
  });
  return { kind: "validation-receipt", value };
}

function row(value = artifact()) {
  return {
    id: value.value.id,
    run_id: value.value.runId,
    correlation_id: value.value.correlationId,
    portfolio_id: "portfolio-a",
    company_id: "company-a",
    artifact_kind: value.kind,
    artifact_hash: value.value.artifactHash,
    predecessor_hash: value.value.receipt.validatorAttestationHash,
    created_at: value.value.createdAt,
    payload: value
  };
}

describe("PostgresOrchestrationExecutionArtifactStore", () => {
  it("appends execution evidence and audit lineage", async () => {
    const value = artifact();
    const sql = new QueueSql([
      { rows: [row(value)], rowCount: 1 },
      { rows: [{ chain_sequence: 1, event_hash: "a".repeat(64) }], rowCount: 1 }
    ]);
    const store = new PostgresOrchestrationExecutionArtifactStore(db(sql));

    await expect(store.append(run(), value)).resolves.toEqual({ created: true });
    expect(sql.calls[0]?.text).toContain("INSERT INTO orchestration_execution_artifacts");
    expect(sql.calls[1]?.text).toContain("getdone_append_audit_event");
  });

  it("treats exact append replay as idempotent", async () => {
    const value = artifact();
    const sql = new QueueSql([
      { rows: [], rowCount: 0 },
      { rows: [row(value)], rowCount: 1 }
    ]);
    const store = new PostgresOrchestrationExecutionArtifactStore(db(sql));

    await expect(store.append(run(), value)).resolves.toEqual({ created: false });
  });

  it("loads the latest hash-verified execution artifact", async () => {
    const value = artifact();
    const sql = new QueueSql([{ rows: [row(value)], rowCount: 1 }]);
    const store = new PostgresOrchestrationExecutionArtifactStore(db(sql));

    await expect(store.latestValidationReceipt(run())).resolves.toEqual(value.value);
    expect(sql.calls[0]?.text).toContain("ORDER BY created_at DESC");
  });

  it("rejects execution evidence outside the orchestration run", async () => {
    const value = artifact();
    const tampered: OrchestrationExecutionArtifact = {
      ...value,
      value: { ...value.value, runId: "different-run" }
    };
    const sql = new QueueSql();
    const store = new PostgresOrchestrationExecutionArtifactStore(db(sql));

    await expect(store.append(run(), tampered)).rejects.toThrow(/integrity|does not belong/i);
    expect(sql.calls).toHaveLength(0);
  });
});
