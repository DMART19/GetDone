import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { AuditEvent } from "@/lib/domain/audit";
import type { TransitionEntity } from "@/lib/domain/services/transition-service";
import { createJobQueueEnvelope } from "@/lib/execution/job-runtime-contracts";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import {
  PostgresAuditLedger,
  PostgresEntityStore
} from "@/lib/persistence/postgres/authority-stores";
import { PostgresDurableJobStore } from "@/lib/persistence/postgres/job-store";

const enabled = process.env.GETDONE_ROLLING_COMPATIBILITY === "true";
const suite = enabled ? describe.sequential : describe.skip;
const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
const evidencePath = process.env.GETDONE_ROLLING_EVIDENCE_PATH?.trim() ?? "";
const codeLabel = process.env.GETDONE_ROLLING_CODE_LABEL?.trim() ?? "unknown";

interface ProbeEntity extends TransitionEntity {
  state: "pending" | "approved";
  marker: string;
}

const scope = Object.freeze({
  userId: "rolling-owner",
  portfolioId: "portfolio-rolling",
  companyId: "company-rolling",
  environment: "staging" as const
});

let db: PostgresDatabase | undefined;

suite("rolling migration authority compatibility", () => {
  afterAll(async () => {
    await db?.close();
  });

  it("preserves authoritative entity, audit, and durable Job semantics", async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL is required");
    if (!evidencePath) throw new Error("GETDONE_ROLLING_EVIDENCE_PATH is required");

    db = new PostgresDatabase({
      connectionString: databaseUrl,
      maxConnections: 4,
      ssl: process.env.GETDONE_DB_SSL !== "false"
    });

    const at = "2026-09-25T18:00:00.000Z";
    const entityStore = new PostgresEntityStore<ProbeEntity>(db, "decision");
    const first: ProbeEntity = {
      id: "decision-rolling",
      correlationId: "corr-rolling",
      portfolioId: scope.portfolioId,
      companyId: scope.companyId,
      state: "pending",
      marker: "rolling-compatibility",
      version: 1,
      updatedAt: at
    };
    await entityStore.create(first);
    const second: ProbeEntity = {
      ...first,
      state: "approved",
      version: 2,
      updatedAt: "2026-09-25T18:00:01.000Z"
    };
    await entityStore.save(second, 1);
    expect(await entityStore.get(first.id)).toEqual(second);

    const audit: AuditEvent = {
      id: "audit-rolling",
      correlationId: "corr-rolling",
      eventType: "decision.approved",
      actor: { type: "user", id: "rolling-owner" },
      scope,
      environment: "staging",
      entityType: "decision",
      entityId: first.id,
      previousState: "pending",
      newState: "approved",
      provenance: "rolling-compatibility",
      occurredAt: "2026-09-25T18:00:02.000Z",
      metadata: { compatibility: true }
    };
    const ledger = new PostgresAuditLedger(db);
    await ledger.append(audit);
    expect(await ledger.listByCorrelationId(audit.correlationId)).toEqual([audit]);

    const envelope = createJobQueueEnvelope({
      id: "queue-rolling",
      correlationId: "corr-rolling",
      jobId: "job-rolling",
      taskId: "task-rolling",
      scope,
      authorizationConsumptionHash: "rolling-consumption-hash",
      idempotencyKey: "enqueue-rolling",
      scheduledAt: "2026-09-25T18:00:03.000Z",
      createdAt: "2026-09-25T18:00:03.000Z"
    });
    const jobs = new PostgresDurableJobStore(db);
    await jobs.enqueue(envelope);
    const runtime = await jobs.getRuntimeSnapshot(envelope.jobId);
    expect(runtime).toMatchObject({
      state: "queued",
      attempt: 0,
      version: 1,
      envelope
    });

    const eventHash = await db.query<{ event_hash: string }>(
      "SELECT event_hash FROM audit_events WHERE id='audit-rolling'"
    );
    const migration = await db.query<{ version: string }>(
      "SELECT version FROM getdone_schema_migrations ORDER BY version DESC LIMIT 1"
    );

    const semantics = {
      entity: second,
      entityHash: sha256Hex(second),
      auditEventHash: eventHash.rows[0]?.event_hash,
      job: {
        state: runtime?.state,
        version: runtime?.version,
        attempt: runtime?.attempt,
        envelopeHash: runtime?.envelope.envelopeHash,
        stateHash: runtime?.stateHash
      },
      migrationVersion: migration.rows[0]?.version
    };
    const evidence = {
      schemaVersion: "1.0.0",
      codeLabel,
      semantics,
      semanticHash: sha256Hex(semantics)
    };
    fs.mkdirSync(path.dirname(path.resolve(evidencePath)), { recursive: true });
    fs.writeFileSync(path.resolve(evidencePath), JSON.stringify(evidence, null, 2) + "\n");
  });
});
