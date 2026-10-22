import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { createOrchestrationRun, createOrchestrationSourceRef } from "./contracts";
import { normalizeObjectiveIntake } from "@/lib/domain/objective-inbox";
import { OperationalStore } from "@/lib/operations/store.server";
import { runGuardedObjectiveReentry } from "./guarded-continuation.server";
import type { VerifiedOutcome } from "@/lib/operations/outcomes";

const url = process.env.GETDONE_AUTH_BOUNDARY_TEST_DATABASE_URL ?? "";
let disposable = false;
try {
  const parsed = new URL(url);
  disposable = process.env.GETDONE_AUTH_BOUNDARY_INTEGRATION === "true"
    && ["127.0.0.1", "localhost"].includes(parsed.hostname)
    && /^getdone_auth_test_[a-z0-9_]+$/.test(parsed.pathname.slice(1));
} catch { /* disabled outside disposable CI */ }

(disposable ? describe.sequential : describe.skip)("real PostgreSQL guarded objective re-entry", () => {
  it("admits one new run under concurrent schedulers and survives restart without replay", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const scope = {
      userId: "owner-" + suffix, portfolioId: "portfolio-" + suffix,
      companyId: "company-" + suffix, environment: "staging" as const
    };
    const before = "2026-10-21T12:00:00.000Z";
    const observed = "2026-10-22T11:50:00.000Z";
    const now = "2026-10-22T12:00:00.000Z";
    const objective = normalizeObjectiveIntake({
      rawText: JSON.stringify({ goal: "Grow monthly revenue", successCriteria: ["Monthly revenue reaches target"] }),
      source: "structured_json"
    }, { scope, correlationId: "reentry-" + suffix, now: before, nextId: () => "objective-" + suffix })[0];
    const accepted = createOrchestrationRun({
      id: "orchestration:objective:" + objective.id,
      correlationId: "objective:" + objective.id,
      source: createOrchestrationSourceRef("objective", objective.id, objective),
      scope, createdAt: before, updatedAt: before
    });
    const { recordHash: ignoredHash, ...base } = accepted;
    void ignoredHash;
    const ref = (id: string) => ({ id, hash: "b".repeat(64) });
    const predecessorBase = {
      ...base, state: "completed" as const, version: 12, updatedAt: now,
      checkpoints: {
        contextSnapshot: ref("context"), plannerInput: ref("input"), plan: ref("plan"),
        validationReceipt: ref("validation"), policySnapshot: ref("policy"), taskDag: ref("dag"),
        decisionIds: [], authorizationGrants: [{ ...ref("grant"), disposition: "AUTO" as const }],
        tasks: [{ ...ref("task"), authorizationConsumptionHash: "c".repeat(64) }],
        jobIds: ["job-" + suffix], verificationRequestIds: ["verification"],
        verifiedOutcomes: [{ id: "orchestration-outcome-" + suffix, verificationReceiptId: "receipt-" + suffix,
          verificationReceiptHash: "d".repeat(64) }]
      }
    };
    const predecessor = { ...predecessorBase, recordHash: sha256Hex(predecessorBase) };
    const outcomeBase = {
      id: "verified-outcome-" + suffix, scope, topic: "revenue", findingId: "finding",
      recommendationId: "recommendation", recommendationKind: "github_repository_health",
      predictedOutcome: "validated", approvedPreviewHash: "a".repeat(64),
      executionReceiptId: "execution", executionReceiptHash: "b".repeat(64),
      verificationReceiptId: "receipt-" + suffix, verificationReceiptHash: "d".repeat(64),
      verificationResult: "verified" as const, objectiveImpact: null, observedAt: "2026-10-22T11:40:00.000Z",
      objectiveId: objective.id, jobId: "job-" + suffix
    };
    const outcome: VerifiedOutcome = { ...outcomeBase, outcomeHash: sha256Hex(outcomeBase) };
    const dbA = new PostgresDatabase({ connectionString: url, ssl: false, maxConnections: 5 });
    const dbB = new PostgresDatabase({ connectionString: url, ssl: false, maxConnections: 5 });
    try {
      const store = new OperationalStore(dbA, scope);
      await store.put("objective", objective.id, objective, now);
      await store.put("verified-outcome", outcome.id,
        { ...outcome, portfolioId: scope.portfolioId, companyId: scope.companyId, environment: scope.environment }, now);
      const proposalId = "continuation-" + suffix;
      await store.put("objective-continuation-proposal", proposalId, {
        id: proposalId, portfolioId: scope.portfolioId, companyId: scope.companyId, environment: scope.environment,
        userId: scope.userId, objectiveId: objective.id, outcomeId: outcome.id,
        verificationReceiptHash: outcome.verificationReceiptHash,
        requiresAdmission: true, consequentialExecutionAuthorized: false
      }, now);
      await store.put("objective-evaluation", "measurement-" + suffix, {
        id: "measurement-" + suffix, portfolioId: scope.portfolioId, companyId: scope.companyId,
        environment: scope.environment, objectiveId: objective.id, observedAt: observed,
        current: 8, achieved: false, metricHash: sha256Hex({ key: "monthlyRevenue" }),
        ownerInputRequired: false, evidenceIds: ["evidence-" + suffix], missingEvidence: []
      }, now);
      await dbA.query(`INSERT INTO orchestration_runs
        (id,correlation_id,portfolio_id,company_id,user_id,environment,source_type,source_id,source_hash,
          state,authority,version,attempt,start_idempotency_key,record_hash,checkpoints,payload,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,'objective',$7,$8,'completed','coordination-only',12,1,$9,$10,$11::jsonb,$12::jsonb,$13,$14)`, [
        predecessor.id, predecessor.correlationId, scope.portfolioId, scope.companyId,
        scope.userId, scope.environment, objective.id, predecessor.source.sourceHash,
        "test:" + suffix, predecessor.recordHash, JSON.stringify(predecessor.checkpoints),
        JSON.stringify(predecessor), predecessor.createdAt, predecessor.updatedAt
      ]);
      const [first, second] = await Promise.all([
        runGuardedObjectiveReentry(dbA, scope, now, true),
        runGuardedObjectiveReentry(dbB, scope, now, true)
      ]);
      expect(first.created + second.created).toBe(1);
      const runs = await dbA.query<{ state: string; authority: string; checkpoints: { authorizationGrants: unknown[] } }>(
        "SELECT state,authority,checkpoints FROM orchestration_runs WHERE source_id=$1 AND id<>$2",
        [objective.id, predecessor.id]
      );
      expect(runs.rows).toHaveLength(1);
      expect(runs.rows[0]).toMatchObject({ state: "accepted", authority: "coordination-only" });
      expect(runs.rows[0].checkpoints.authorizationGrants).toEqual([]);
      // A fresh process on the same durable store sees the unfinished successor,
      // and cannot create a third run from the original verified outcome.
      await dbB.close();
      const restarted = new PostgresDatabase({ connectionString: url, ssl: false });
      try {
        expect((await runGuardedObjectiveReentry(restarted, scope, now, true)).created).toBe(0);
      } finally { await restarted.close(); }
    } finally {
      await dbA.query("DELETE FROM orchestration_worker_state WHERE run_id IN (SELECT id FROM orchestration_runs WHERE source_id=$1)", [objective.id]);
      await dbA.query("DELETE FROM orchestration_checkpoints WHERE run_id IN (SELECT id FROM orchestration_runs WHERE source_id=$1)", [objective.id]);
      await dbA.query("DELETE FROM orchestration_runs WHERE source_id=$1", [objective.id]);
      await dbA.query("DELETE FROM control_plane_entities WHERE portfolio_id=$1 AND company_id=$2", [scope.portfolioId, scope.companyId]);
      await Promise.all([dbA.close(), dbB.close()]);
    }
  }, 30000);
});
