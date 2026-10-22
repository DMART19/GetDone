import type { ObjectiveRecord } from "@/lib/domain/objective-inbox";
import type { OrchestrationRunRecord } from "@/lib/orchestration/contracts";
import { PostgresOrchestrationRunStore } from "@/lib/persistence/postgres/orchestration-store";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";
import { OperationalStore } from "@/lib/operations/store.server";
import type { VerifiedOutcome } from "@/lib/operations/outcomes";
import type { ObjectiveEvaluation } from "@/lib/operations/objective-evaluation";
import { persistGuardedContinuation } from "./guarded-continuation";

/**
 * Opt-in execution entry point. The only mutation is creating an accepted,
 * coordination-only run in the EXISTING durable orchestration pipeline.
 * No approval, task, provider operation or policy is created here.
 */
export async function runGuardedObjectiveReentry(
  db: PostgresTransactionalDatabase,
  scope: { userId: string; portfolioId: string; companyId: string; environment: "development" | "staging" | "production" },
  now: string,
  enabled: boolean
): Promise<{ created: number; replayed: number }> {
  if (!enabled) return { created: 0, replayed: 0 };
  const operational = new OperationalStore(db, scope);
  const proposals = await operational.list<{
    id: string; objectiveId: string; outcomeId: string; verificationReceiptHash: string;
    userId: string; portfolioId: string; companyId: string; environment: string;
    requiresAdmission: boolean; consequentialExecutionAuthorized: false;
  }>("objective-continuation-proposal");
  let created = 0;
  let replayed = 0;
  for (const proposal of proposals.slice(0, 20)) {
    if (!proposal.requiresAdmission || proposal.consequentialExecutionAuthorized !== false
      || proposal.userId !== scope.userId || proposal.portfolioId !== scope.portfolioId
      || proposal.companyId !== scope.companyId || proposal.environment !== scope.environment) continue;
    // Serialize competing scheduler instances against the same company+objective.
    const result = await db.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `objective-reentry:${scope.portfolioId}:${scope.companyId}:${proposal.objectiveId}`
      ]);
      const [obj, out, runs, evaluations] = await Promise.all([
        client.query<{ payload: ObjectiveRecord }>(
          "SELECT payload FROM control_plane_entities WHERE entity_type='objective' AND portfolio_id=$1 AND company_id=$2 AND payload->>'id'=$3 AND payload->>'environment'=$4 LIMIT 1",
          [scope.portfolioId, scope.companyId, proposal.objectiveId, scope.environment]),
        client.query<{ payload: VerifiedOutcome }>(
          "SELECT payload FROM control_plane_entities WHERE entity_type='verified-outcome' AND portfolio_id=$1 AND company_id=$2 AND payload->>'id'=$3 AND payload->>'environment'=$4 LIMIT 1",
          [scope.portfolioId, scope.companyId, proposal.outcomeId, scope.environment]),
        client.query<{ payload: OrchestrationRunRecord }>(
          "SELECT payload FROM orchestration_runs WHERE portfolio_id=$1 AND company_id=$2 AND user_id=$3 AND environment=$4 AND source_type='objective' AND source_id=$5 ORDER BY created_at DESC,id DESC LIMIT 5",
          [scope.portfolioId, scope.companyId, scope.userId, scope.environment, proposal.objectiveId]),
        client.query<{ payload: ObjectiveEvaluation }>(
          "SELECT payload FROM control_plane_entities WHERE entity_type='objective-evaluation' AND portfolio_id=$1 AND company_id=$2 AND payload->>'objectiveId'=$3 AND payload->>'environment'=$4 ORDER BY updated_at DESC LIMIT 20",
          [scope.portfolioId, scope.companyId, proposal.objectiveId, scope.environment])
      ]);
      const objective = obj.rows[0]?.payload;
      const outcome = out.rows[0]?.payload;
      if (!objective || !outcome || !runs.rows.length
        || outcome.verificationReceiptHash !== proposal.verificationReceiptHash) return "ineligible" as const;
      // Provider success cannot substitute for independently measured progress.
      // The newest observation for every present metric must be fresh,
      // newer than the verified operation, and still below the target.
      const latestByMetric = new Map<string, ObjectiveEvaluation>();
      for (const { payload: measurement } of evaluations.rows) {
        if (!latestByMetric.has(measurement.metricHash)) latestByMetric.set(measurement.metricHash, measurement);
      }
      if (!latestByMetric.size || [...latestByMetric.values()].some(measurement =>
        measurement.portfolioId !== scope.portfolioId || measurement.companyId !== scope.companyId
        || measurement.environment !== scope.environment || measurement.objectiveId !== proposal.objectiveId
        || measurement.achieved || measurement.current === null || measurement.ownerInputRequired
        || !measurement.evidenceIds.length || (measurement.missingEvidence?.length ?? 1) > 0
        || !Number.isFinite(Date.parse(measurement.observedAt))
        || Date.parse(measurement.observedAt) <= Date.parse(outcome.observedAt)
        || Date.parse(measurement.observedAt) > Date.parse(now)
        || Date.parse(now) - Date.parse(measurement.observedAt) > 15 * 60_000
      )) return "ineligible" as const;
      const predecessor = runs.rows[0].payload;
      // Only the latest completed run may support another cycle. No outstanding
      // run can be superseded by a scheduler callback.
      if (predecessor.state !== "completed") return "ineligible" as const;
      const store = new PostgresOrchestrationRunStore(db);
      return persistGuardedContinuation({
        objective, outcome, predecessor,
        runCount: runs.rows.length,
        now,
        runs: {
          get: async id => {
            const record = await client.query<{ payload: OrchestrationRunRecord }>(
              "SELECT payload FROM orchestration_runs WHERE id=$1 AND portfolio_id=$2 AND company_id=$3",
              [id, scope.portfolioId, scope.companyId]);
            return record.rows[0]?.payload ?? null;
          },
          create: (candidate, key) => store.createInTransaction(client, candidate, key)
        }
      });
    });
    if (result === "created") created++;
    if (result === "replayed") replayed++;
  }
  return { created, replayed };
}
