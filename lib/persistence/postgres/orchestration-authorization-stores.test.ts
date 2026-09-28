import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { AuthoritativeDecision, DecisionResumeRequest } from "@/lib/domain/decision-service";
import {
  PostgresDecisionResumeRequestStore,
  PostgresOrchestrationDecisionStore
} from "@/lib/persistence/postgres/orchestration-authorization-stores";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";

interface ResponseSpec {
  rows?: QueryResultRow[];
  rowCount?: number;
}

class ScriptedDb implements SqlQueryable {
  readonly calls: string[] = [];
  constructor(private readonly responses: ResponseSpec[]) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string
  ): Promise<QueryResult<R>> {
    this.calls.push(text.replace(/\s+/g, " ").trim());
    const response = this.responses.shift() ?? { rows: [], rowCount: 0 };
    return {
      command: "",
      rowCount: response.rowCount ?? response.rows?.length ?? 0,
      oid: 0,
      fields: [],
      rows: (response.rows ?? []) as R[]
    };
  }
}

function decision(): AuthoritativeDecision {
  return {
    id: "decision:run-1:policy-v8:step-1",
    correlationId: "correlation-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    status: "pending",
    version: 1,
    requiresStepUp: false,
    updatedAt: "2026-09-28T13:00:00.000Z",
    approvalBinding: {
      orchestrationRunId: "run-1",
      policyEvaluationArtifactId: "policy-1",
      policyEvaluationArtifactHash: "a".repeat(64),
      planArtifactId: "plan-1",
      planArtifactHash: "b".repeat(64),
      planHash: "c".repeat(64),
      stepId: "step-1",
      stepHash: "d".repeat(64),
      policySnapshotId: "snapshot-1",
      policySnapshotHash: "e".repeat(64),
      validationReceiptId: "receipt-1",
      validationReceiptHash: "f".repeat(64),
      requirement: "approval",
      proofExpiresAt: "2026-09-28T13:10:00.000Z"
    }
  };
}

function resumeRequest(): DecisionResumeRequest {
  const base = {
    id: "decision-resume:decision-1:v2",
    runId: "run-1",
    decisionId: "decision-1",
    decisionVersion: 2,
    correlationId: "correlation-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    resolution: "approved" as const,
    createdAt: "2026-09-28T13:01:00.000Z"
  };
  return Object.freeze({
    ...base,
    requestHash: sha256Hex(base)
  });
}

describe("PostgreSQL orchestration authorization stores", () => {
  it("creates an orchestration Decision and replays only identical authoritative content", async () => {
    const value = decision();
    const createDb = new ScriptedDb([{ rowCount: 1 }]);
    expect(await new PostgresOrchestrationDecisionStore(createDb).create(value))
      .toEqual({ status: "created", decision: value });

    const replayDb = new ScriptedDb([
      { rowCount: 0 },
      { rows: [{ payload: value }] }
    ]);
    expect(await new PostgresOrchestrationDecisionStore(replayDb).create(value))
      .toEqual({ status: "idempotent-replay", decision: value });
  });

  it("replays an owner-resolved Decision when immutable authorization lineage is unchanged", async () => {
    const value = decision();
    const approved = {
      ...value,
      status: "approved" as const,
      version: 2,
      updatedAt: "2026-09-28T13:01:00.000Z",
      resolvedBy: "owner-a"
    };
    const db = new ScriptedDb([
      { rowCount: 0 },
      { rows: [{ payload: approved }] }
    ]);

    expect(await new PostgresOrchestrationDecisionStore(db).create(value))
      .toEqual({ status: "idempotent-replay", decision: approved });
  });

  it("rejects deterministic Decision ID reuse with different content", async () => {
    const value = decision();
    const conflicting = {
      ...value,
      requiresStepUp: true
    };
    const db = new ScriptedDb([
      { rowCount: 0 },
      { rows: [{ payload: conflicting }] }
    ]);

    await expect(
      new PostgresOrchestrationDecisionStore(db).create(value)
    ).rejects.toThrow(/different immutable authorization lineage/i);
  });

  it("persists and idempotently replays Decision resume requests", async () => {
    const request = resumeRequest();
    const createdDb = new ScriptedDb([{ rowCount: 1 }]);
    await expect(
      new PostgresDecisionResumeRequestStore(createdDb).create(request)
    ).resolves.toBeUndefined();

    const replayDb = new ScriptedDb([
      { rowCount: 0 },
      {
        rows: [{
          payload: request,
          status: "pending",
          processed_at: null
        }]
      }
    ]);
    await expect(
      new PostgresDecisionResumeRequestStore(replayDb).create(request)
    ).resolves.toBeUndefined();
  });

  it("rejects a tampered Decision resume request hash", async () => {
    const request = resumeRequest();
    const store = new PostgresDecisionResumeRequestStore(new ScriptedDb([]));
    await expect(store.create({
      ...request,
      resolution: "rejected"
    })).rejects.toThrow(/integrity/i);
  });

  it("marks resume requests processed idempotently", async () => {
    const request = resumeRequest();
    const created = new ScriptedDb([{ rowCount: 1 }]);
    await expect(
      new PostgresDecisionResumeRequestStore(created).markProcessed(
        request.id,
        request.requestHash,
        "2026-09-28T13:02:00.000Z"
      )
    ).resolves.toBeUndefined();

    const replay = new ScriptedDb([
      { rowCount: 0 },
      {
        rows: [{
          request_hash: request.requestHash,
          status: "processed"
        }]
      }
    ]);
    await expect(
      new PostgresDecisionResumeRequestStore(replay).markProcessed(
        request.id,
        request.requestHash,
        "2026-09-28T13:03:00.000Z"
      )
    ).resolves.toBeUndefined();
  });

  it("reads pending queue rows with bounded ordering", async () => {
    const request = resumeRequest();
    const db = new ScriptedDb([
      {
        rows: [{
          payload: request,
          status: "pending"
        }]
      }
    ]);
    const pending = await new PostgresDecisionResumeRequestStore(db).listPending(25);
    expect(pending).toEqual([{
      ...request,
      status: "pending"
    }]);
    expect(db.calls[0]).toMatch(/WHERE status='pending'/);
  });
});
