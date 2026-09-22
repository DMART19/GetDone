import { describe, expect, it } from "vitest";
import { createVerificationEvidence } from "@/lib/verification/verification";
import {
  PostgresJobVerificationEvidenceStore,
  PostgresJobWorkerInstanceStore,
  workerErrorHash
} from "@/lib/persistence/postgres/worker-runtime-stores";

class SequenceDb {
  calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  responses: Array<{ rows: unknown[]; rowCount?: number }> = [];

  async query(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values });
    return (this.responses.shift() ?? { rows: [], rowCount: 0 }) as never;
  }
}

describe("Postgres worker runtime stores", () => {
  it("persists and reads worker liveness records", async () => {
    const db = new SequenceDb();
    const store = new PostgresJobWorkerInstanceStore(db as never);
    const record = {
      workerId: "worker-a",
      processRole: "job-worker" as const,
      startedAt: "2026-09-22T07:00:00.000Z",
      lastPollAt: "2026-09-22T07:00:01.000Z",
      lastSuccessAt: "2026-09-22T07:00:02.000Z",
      status: "running" as const,
      updatedAt: "2026-09-22T07:00:02.000Z"
    };

    await store.upsert(record);
    expect(db.calls[0].values).toEqual([
      "worker-a",
      "job-worker",
      record.startedAt,
      record.lastPollAt,
      record.lastSuccessAt,
      null,
      null,
      "running",
      record.updatedAt
    ]);

    db.responses.push({
      rows: [{
        worker_id: "worker-a",
        process_role: "job-worker",
        started_at: new Date(record.startedAt),
        last_poll_at: record.lastPollAt,
        last_success_at: new Date(record.lastSuccessAt),
        last_error_at: null,
        last_error_hash: null,
        status: "running",
        updated_at: new Date(record.updatedAt)
      }],
      rowCount: 1
    });
    await expect(store.get("worker-a")).resolves.toEqual(record);

    db.responses.push({ rows: [], rowCount: 0 });
    await expect(store.get("missing")).resolves.toBeNull();
  });

  it("persists verification evidence idempotently and rejects lineage drift", async () => {
    const evidence = createVerificationEvidence({
      id: "evidence-1",
      portfolioId: "portfolio",
      companyId: "company",
      subject: { type: "job", id: "job-1" },
      strategy: "business",
      result: "pass",
      sourceType: "provider",
      sourceId: "provider-op-1",
      independenceKey: "provider-op-1",
      observedAt: "2026-09-22T07:00:02.000Z",
      payloadHash: "payload-hash",
      provenance: "test"
    });

    const insertedDb = new SequenceDb();
    insertedDb.responses.push({ rows: [], rowCount: 1 });
    const insertedStore = new PostgresJobVerificationEvidenceStore(insertedDb as never);
    await expect(
      insertedStore.put("job-1", "request-1", evidence)
    ).resolves.toBeUndefined();
    expect(insertedDb.calls[0].values?.slice(0, 6)).toEqual([
      evidence.id,
      "job-1",
      "request-1",
      "portfolio",
      "company",
      evidence.evidenceHash
    ]);

    const duplicateDb = new SequenceDb();
    duplicateDb.responses.push(
      { rows: [], rowCount: 0 },
      { rows: [{ evidence_hash: evidence.evidenceHash }], rowCount: 1 }
    );
    await expect(
      new PostgresJobVerificationEvidenceStore(duplicateDb as never)
        .put("job-1", "request-1", evidence)
    ).resolves.toBeUndefined();

    const conflictDb = new SequenceDb();
    conflictDb.responses.push(
      { rows: [], rowCount: 0 },
      { rows: [{ evidence_hash: "different" }], rowCount: 1 }
    );
    await expect(
      new PostgresJobVerificationEvidenceStore(conflictDb as never)
        .put("job-1", "request-1", evidence)
    ).rejects.toThrow(/reused with different content/i);

    await expect(
      insertedStore.put("other-job", "request-1", evidence)
    ).rejects.toThrow(/not bound to the executing Job/i);
  });

  it("hashes worker failures deterministically without storing raw error objects", () => {
    expect(workerErrorHash(new Error("database unavailable")))
      .toBe(workerErrorHash(new Error("database unavailable")));
    expect(workerErrorHash("database unavailable"))
      .toBe(workerErrorHash(new Error("database unavailable")));
    expect(workerErrorHash(new Error("other")))
      .not.toBe(workerErrorHash(new Error("database unavailable")));
  });
});
