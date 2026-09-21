import { describe, expect, it } from "vitest";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import type { AtomicReservationCommit } from "@/lib/resources/reservations";
import { PostgresAtomicReservationStore } from "@/lib/persistence/postgres/reservation-store";
import {
  PostgresBusinessActionExecutionStore,
  PostgresSoftwareWorkerRuntimeStore
} from "@/lib/persistence/postgres/execution-stores";
import { PostgresJobExecutionSpecStore } from "@/lib/persistence/postgres/job-execution-spec-store";
import { createPersistedJobExecutionSpec } from "@/lib/execution/job-execution-router";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";
import type { BusinessActionExecutionRecord } from "@/lib/execution/business-action-orchestrator";
import type { SoftwareWorkerRuntimeRecord } from "@/lib/execution/software-worker-runtime";

interface ResponseSpec {
  rows?: QueryResultRow[];
  rowCount?: number;
}

class ScriptedDb implements PostgresTransactionalDatabase {
  readonly calls: string[] = [];
  constructor(private readonly responses: ResponseSpec[]) {}

  async query<R extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<R>> {
    this.calls.push(text.replace(/\s+/g, " ").trim());
    const response = this.responses.shift() ?? { rows: [], rowCount: 1 };
    return {
      command: "",
      rowCount: response.rowCount ?? response.rows?.length ?? 0,
      oid: 0,
      fields: [],
      rows: (response.rows ?? []) as R[]
    };
  }

  async transaction<T>(operation: (client: PoolClient) => Promise<T>) {
    return operation(this as unknown as PoolClient);
  }
}

const businessRecord: BusinessActionExecutionRecord = {
  requestId: "action-1",
  jobId: "job-1",
  requestHash: "request-hash",
  adapterId: "adapter-1",
  adapterVersion: "1.0.0",
  providerOperationId: "provider-1",
  state: "running",
  adapterResultHash: "adapter-result",
  retryable: true,
  updatedAt: "2026-09-21T04:00:00Z",
  recordHash: "record-hash"
};

const softwareRecord = {
  planId: "plan-1",
  planHash: "plan-hash",
  pipeline: { state: "inspect" },
  artifacts: {
    staticAnalysisEvidenceIds: [],
    testEvidenceIds: [],
    securityEvidenceIds: []
  },
  updatedAt: "2026-09-21T04:00:00Z",
  runtimeHash: "runtime-hash"
} as unknown as SoftwareWorkerRuntimeRecord;

describe("PostgreSQL execution persistence stores", () => {
  it("inserts and compare-and-swap updates business action execution", async () => {
    const db = new ScriptedDb([
      { rowCount: 1 },
      { rowCount: 1 },
      { rows: [{ payload: businessRecord }] }
    ]);
    const store = new PostgresBusinessActionExecutionStore(db);
    await store.save(businessRecord);
    const next = { ...businessRecord, state: "completed" as const, recordHash: "record-hash-2" };
    await store.save(next, businessRecord.recordHash);
    expect(await store.get(businessRecord.requestId)).toEqual(businessRecord);
    expect(db.calls.some((call) => call.includes("WHERE request_id=$1 AND record_hash=$7"))).toBe(true);
  });

  it("rejects business action CAS conflicts", async () => {
    const db = new ScriptedDb([{ rowCount: 0 }]);
    await expect(new PostgresBusinessActionExecutionStore(db).save(
      { ...businessRecord, recordHash: "new" },
      "old"
    )).rejects.toThrow(/compare-and-swap/i);
  });

  it("persists software worker runtime with CAS", async () => {
    const db = new ScriptedDb([
      { rowCount: 1 },
      { rowCount: 1 },
      { rows: [{ payload: softwareRecord }] }
    ]);
    const store = new PostgresSoftwareWorkerRuntimeStore(db);
    await store.save(softwareRecord);
    await store.save({ ...softwareRecord, runtimeHash: "runtime-hash-2" }, softwareRecord.runtimeHash);
    expect(await store.get(softwareRecord.planId)).toEqual(softwareRecord);
  });

  it("persists immutable hash-bound Job execution specs", async () => {
    const record = createPersistedJobExecutionSpec({
      kind: "software-prepare",
      jobId: "job-1",
      plan: {} as never
    }, "2026-09-21T04:00:00Z");
    const db = new ScriptedDb([{ rowCount: 1 }, { rows: [{ payload: record }] }]);
    const store = new PostgresJobExecutionSpecStore(db);
    await store.put(record);
    expect(await store.get("job-1")).toEqual(record);
  });

  it("commits ledger and reservation mutation in one transaction", async () => {
    const reservation = {
      id: "reservation-1",
      portfolioId: "portfolio",
      companyId: "company",
      idempotencyKey: "reserve-1"
    };
    const ledger = {
      id: "ledger-1",
      portfolioId: "portfolio",
      companyId: "company",
      revision: 2,
      ledgerHash: "ledger-next"
    };
    const input = {
      transactionId: "reservation-tx-1",
      idempotencyKey: "reserve-1",
      ledgerId: "ledger-1",
      expectedLedgerRevision: 1,
      expectedLedgerHash: "ledger-current",
      expectedReservationHash: undefined,
      nextLedgerRevision: 2,
      nextLedgerHash: "ledger-next",
      nextLedger: ledger,
      nextReservation: reservation,
      nextReservationHash: "reservation-next",
      commitHash: "commit-next"
    } as unknown as AtomicReservationCommit;

    const db = new ScriptedDb([
      { rows: [] },
      { rows: [{ revision: 1, ledger_hash: "ledger-current" }] },
      { rows: [] },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 }
    ]);
    const store = new PostgresAtomicReservationStore(db);
    expect(await store.commit(input)).toEqual({ status: "committed", commitHash: "commit-next" });
    expect(db.calls.some((call) => call.includes("UPDATE capacity_ledgers"))).toBe(true);
    expect(db.calls.some((call) => call.includes("INSERT INTO reservation_commits"))).toBe(true);
  });

  it("returns reservation conflict without mutating stale ledgers", async () => {
    const input = {
      transactionId: "reservation-tx-1",
      idempotencyKey: "reserve-1",
      ledgerId: "ledger-1",
      expectedLedgerRevision: 1,
      expectedLedgerHash: "expected",
      nextLedgerRevision: 2,
      nextLedgerHash: "next",
      nextLedger: {},
      nextReservation: {
        id: "reservation-1",
        portfolioId: "portfolio",
        companyId: "company",
        idempotencyKey: "reserve-1"
      },
      nextReservationHash: "reservation-next",
      commitHash: "commit-next"
    } as unknown as AtomicReservationCommit;

    const db = new ScriptedDb([
      { rows: [] },
      { rows: [{ revision: 2, ledger_hash: "different" }] }
    ]);
    const result = await new PostgresAtomicReservationStore(db).commit(input);
    expect(result).toEqual({ status: "conflict", currentLedgerRevision: 2 });
  });
});
