import type { SqlQueryable } from "@/lib/persistence/postgres/client";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { OperationScope, OwnerInboxItem, NormalizedEvidence, OperationalConnection } from "./contracts";
import { inboxSchema, evidenceSchema, connectionSchema } from "./contracts";
import { actionableInbox, inboxObjectId } from "./inbox";
import { evaluateObjective, evaluationInbox, type ObjectiveMetric, type ObjectiveEvaluation } from "./objective-evaluation";
import type { ObjectiveRecord } from "@/lib/domain/objective-inbox";
import type { VerifiedOutcome } from "./outcomes";
import { associateMeasuredImpact } from "./outcomes";
import type { VerificationReceipt } from "@/lib/verification/verification";
import type { BusinessActionExecutionRecord } from "@/lib/execution/business-action-orchestrator";
import type { AuthoritativeDecision } from "@/lib/domain/decision-service";
import type { JobRecord } from "@/lib/domain/services/job-service";
import { authorizedEvidence } from "./evidence";
import { adviseObjectiveContinuation } from "./objective-continuation";

export class OperationalStore {
  constructor(private readonly db: SqlQueryable, readonly scope: OperationScope) {}
  async list<T>(entityType: string): Promise<T[]> {
    const result = await this.db.query<{ payload: T }>(`SELECT payload FROM control_plane_entities
      WHERE entity_type=$1 AND portfolio_id=$2 AND company_id=$3 AND payload->>'environment'=$4
      ORDER BY updated_at DESC,id LIMIT 1000`, [entityType, this.scope.portfolioId, this.scope.companyId, this.scope.environment]);
    return result.rows.map(r => r.payload);
  }
  async connections(): Promise<OperationalConnection[]> {
    return (await this.list<unknown>("operational-connection")).flatMap(r => { const p = connectionSchema.safeParse(r); return p.success ? [p.data] : []; });
  }
  async evidence(): Promise<NormalizedEvidence[]> {
    return (await this.list<unknown>("normalized-evidence")).flatMap(r => { const p = evidenceSchema.safeParse(r); return p.success ? [p.data] : []; });
  }
  async inbox(now: number): Promise<OwnerInboxItem[]> {
    const rows = await this.list<OwnerInboxItem>("owner-inbox-item");
    return actionableInbox(rows, this.scope, now);
  }
  async refreshInbox(now: string) {
    const result = await this.db.query<{ id: string; entity_type: string; title: string; state: string; updated_at: string }>(
      `SELECT id,entity_type,COALESCE(payload->>'title',payload->>'normalizedGoal',id) AS title,
       COALESCE(payload->>'state',payload->>'status','unknown') AS state,updated_at
       FROM control_plane_entities WHERE portfolio_id=$1 AND company_id=$2
       AND entity_type=ANY($3::text[]) AND (payload->>'environment'=$4 OR
         payload->'approvalBinding'->'trustedScope'->>'environment'=$4 OR
         payload->'authorizationConsumption'->'scope'->>'environment'=$4)
       AND LOWER(COALESCE(payload->>'sensitivity',payload->>'dataClass',payload->'scope'->>'dataClass','internal')) IN ('public','internal')`,
      [this.scope.portfolioId, this.scope.companyId, ["decision", "job", "objective"], this.scope.environment]);
    for (const row of result.rows) {
      if (row.entity_type === "objective" && !["failed", "blocked", "needs_owner_input", "completed", "cancelled"].includes(row.state)) continue;
      const kind = row.entity_type === "decision" ? "approval" : row.entity_type === "job" ? "job"
        : row.state === "needs_owner_input" ? "owner-input" : "objective";
      const open = kind === "approval" ? row.state === "pending" : ["failed", "blocked", "needs_owner_input", "verifying", "provider_completed", "uncertain"].includes(row.state);
      const href = kind === "approval" ? `/decisions/${encodeURIComponent(row.id)}` : kind === "job"
        ? `/operations/jobs/${encodeURIComponent(row.id)}` : `/objectives/${encodeURIComponent(row.id)}`;
      await this.saveInbox({ id: inboxObjectId(this.scope, row.entity_type, row.id), portfolioId: this.scope.portfolioId,
        companyId: this.scope.companyId, environment: this.scope.environment, userId: this.scope.userId,
        objectType: row.entity_type, objectId: row.id, kind, state: open ? "open" : "resolved", summary: `${row.title}: ${row.state}`,
        urgency: row.state === "failed" ? 1 : 0.6, impact: 0.6, confidence: 1,
        createdAt: new Date(row.updated_at).toISOString(), updatedAt: now, sensitivity: "internal", nextAction: { label: "Review", href } });
    }
    for (const connection of await this.connections()) {
      if (!connection.grantedUserIds.includes(this.scope.userId)) continue;
      const open = ["broken", "degraded", "blocked"].includes(connection.status)
        || Boolean(connection.expiresAt && Date.parse(connection.expiresAt) < Date.parse(now) + 7 * 86400_000);
      await this.saveInbox({ id: inboxObjectId(this.scope, "connection", connection.id), portfolioId: this.scope.portfolioId,
        companyId: this.scope.companyId, environment: this.scope.environment, userId: this.scope.userId,
        objectType: "connection", objectId: connection.id, kind: "connection", state: open ? "open" : "resolved",
        summary: `${connection.provider} connection needs attention`, urgency: connection.status === "broken" ? 1 : 0.5,
        impact: 0.7, confidence: 1, createdAt: connection.updatedAt, updatedAt: now, sensitivity: "internal",
        nextAction: { label: "Review business connections", href: "/resources" } });
    }
    const turns = await this.db.query<{ id: string; payload: { threadId?: string; conversationState?: { question?: string } } }>(
      `SELECT DISTINCT ON (payload->>'threadId') id,payload FROM owner_intents
       WHERE portfolio_id=$1 AND company_id=$2 AND user_id=$3 AND payload->>'environment'=$4
       ORDER BY payload->>'threadId',received_at DESC,id DESC`,
      [this.scope.portfolioId, this.scope.companyId, this.scope.userId, this.scope.environment]);
    for (const row of turns.rows) {
      const objectId = row.payload.threadId ?? row.id;
      const question = row.payload.conversationState?.question;
      await this.saveInbox({ id: inboxObjectId(this.scope, "conversation", objectId), portfolioId: this.scope.portfolioId,
        companyId: this.scope.companyId, environment: this.scope.environment, userId: this.scope.userId,
        objectType: "conversation", objectId, kind: "ambiguity", state: question ? "open" : "resolved",
        summary: question ?? "Conversation ambiguity resolved", urgency: 0.4, impact: 0.3, confidence: 1,
        createdAt: now, updatedAt: now, sensitivity: "internal", nextAction: { label: "Clarify in conversation", href: "/" } });
    }
  }
  async put<T extends { portfolioId: string; companyId: string; environment: string }>(entityType: string, id: string, payload: T, now: string) {
    if (payload.portfolioId !== this.scope.portfolioId || payload.companyId !== this.scope.companyId || payload.environment !== this.scope.environment)
      throw new ControlPlaneError("FORBIDDEN", "Operational persistence requires exact tenant/environment scope");
    const storageId = `${entityType}:${sha256Hex({ portfolioId: this.scope.portfolioId, companyId: this.scope.companyId, environment: this.scope.environment, id })}`;
    const result = await this.db.query(`INSERT INTO control_plane_entities
      (entity_type,id,portfolio_id,company_id,version,updated_at,payload) VALUES($1,$2,$3,$4,1,$5,$6::jsonb)
      ON CONFLICT(entity_type,id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=EXCLUDED.updated_at,version=control_plane_entities.version+1
      WHERE control_plane_entities.portfolio_id=EXCLUDED.portfolio_id AND control_plane_entities.company_id=EXCLUDED.company_id
      RETURNING id`, [entityType, storageId, this.scope.portfolioId, this.scope.companyId, now, JSON.stringify(payload)]);
    if (!result.rowCount) throw new ControlPlaneError("CONFLICT", "Operational record scope conflict");
  }
  async saveInbox(item: OwnerInboxItem) {
    const parsed = inboxSchema.parse(item);
    if (parsed.userId !== this.scope.userId) throw new ControlPlaneError("FORBIDDEN", "Inbox item belongs to another owner");
    const previous = (await this.list<OwnerInboxItem>("owner-inbox-item")).find(p => p.id === parsed.id);
    return this.put("owner-inbox-item", parsed.id, { ...parsed, createdAt: previous?.createdAt ?? parsed.createdAt }, parsed.updatedAt);
  }
  async saveEvidence(evidence: NormalizedEvidence) {
    const parsed = evidenceSchema.parse(evidence);
    const { contentHash, ...base } = parsed;
    if (sha256Hex(base) !== contentHash || !parsed.authorization.grantedUserIds.includes(this.scope.userId))
      throw new ControlPlaneError("FORBIDDEN", "Evidence integrity or authorization failed");
    await this.put("normalized-evidence", parsed.evidenceId, parsed, parsed.observedAt);
  }
  async captureVerifiedOutcomes(now: string) {
    const existing = new Set((await this.list<VerifiedOutcome>("verified-outcome")).map(o => o.id));
    const recordedContinuations = new Set((await this.list<{ id: string }>("objective-continuation-proposal")).map(o => o.id));
    const result = await this.db.query<{ job: JobRecord; decision: AuthoritativeDecision; receipt: VerificationReceipt; execution: BusinessActionExecutionRecord }>(
      `SELECT j.payload AS job,d.payload AS decision,v.payload AS receipt,b.payload AS execution
       FROM control_plane_entities j JOIN verification_receipts v ON v.id=j.payload->>'verificationReceiptId'
       JOIN control_plane_entities d ON d.entity_type='decision' AND d.id=j.payload->>'decisionId'
       JOIN business_action_executions b ON b.job_id=j.id
       WHERE j.entity_type='job' AND j.portfolio_id=$1 AND j.company_id=$2
       AND v.portfolio_id=j.portfolio_id AND v.company_id=j.company_id
       AND d.portfolio_id=j.portfolio_id AND d.company_id=j.company_id
       AND v.payload->>'environment'=$3 AND j.payload->>'state'='verified' AND b.state='completed'`,
      [this.scope.portfolioId, this.scope.companyId, this.scope.environment]);
    for (const { job, decision, receipt, execution } of result.rows) {
      const preview = decision.executionPreview;
      if (!preview || preview.scope.userId !== this.scope.userId || receipt.verdict !== "verified"
        || receipt.subject.id !== job.id || receipt.receiptHash !== job.verificationReceiptHash) continue;
      const { receiptHash, ...receiptBase } = receipt;
      const { recordHash, ...executionBase } = execution;
      if (sha256Hex(receiptBase) !== receiptHash || sha256Hex(executionBase) !== recordHash) continue;
      const planResult = await this.db.query<{ payload: import("@/lib/orchestration/planning-flow").PersistedPlanProposal }>(
        `SELECT payload FROM orchestration_plan_proposals WHERE id=$1 AND portfolio_id=$2 AND company_id=$3`,
        [decision.approvalBinding?.planArtifactId, this.scope.portfolioId, this.scope.companyId]);
      const plan = planResult.rows[0]?.payload;
      const step = plan?.proposal.steps.find(s => s.id === decision.approvalBinding?.stepId);
      if (!step || plan?.planHash !== preview.planHash) continue;
      const base = { id: `verified-outcome:${sha256Hex({ jobId: job.id, receiptHash })}`, scope: this.scope,
        portfolioId: this.scope.portfolioId, companyId: this.scope.companyId, environment: this.scope.environment,
        topic: "deployment", findingId: step.evidenceIds[0] ?? `plan:${preview.planHash}`, recommendationId: step.id,
        objectiveId: plan.proposal.source.type === "objective" ? plan.proposal.source.objectiveId : undefined,
        jobId: job.id,
        recommendationKind: preview.workflow, predictedOutcome: step.expectedOutcome, approvedPreviewHash: preview.previewHash,
        executionReceiptId: execution.requestId, executionReceiptHash: recordHash, verificationReceiptId: receipt.id,
        verificationReceiptHash: receiptHash, verificationResult: "verified" as const,
        // Verification of branch creation alone is not evidence of business improvement.
        objectiveImpact: null, observedAt: receipt.verifiedAt };
      const outcome: VerifiedOutcome = { ...base, outcomeHash: sha256Hex(base) };
      const continuationKey = outcome.objectiveId
        ? `continuation:${sha256Hex({ objectiveId: outcome.objectiveId, outcomeHash: outcome.outcomeHash })}` : undefined;
      if (!existing.has(outcome.id) || (continuationKey && !recordedContinuations.has(continuationKey))) {
        if (!existing.has(outcome.id)) await this.put("verified-outcome", outcome.id, { ...base, outcomeHash: outcome.outcomeHash }, now);
        // A verified provider action may justify more work, but never proves
        // business impact and never creates execution authority by itself.
        if (outcome.objectiveId) {
          const objectives = await this.list<ObjectiveRecord>("objective");
          const objective = objectives.find(item => item.id === outcome.objectiveId
            && item.createdByUserId === this.scope.userId);
          if (objective) {
            const dependencies = Object.fromEntries(objectives.map(item => [item.id, item.status]));
            const recommendation = adviseObjectiveContinuation(objective, dependencies);
            const continuationId = continuationKey!;
            await this.put("objective-continuation-proposal", continuationId, {
              id: continuationId, portfolioId: this.scope.portfolioId, companyId: this.scope.companyId,
              environment: this.scope.environment, userId: this.scope.userId,
              objectiveId: objective.id, outcomeId: outcome.id, verificationReceiptHash: receiptHash,
              decision: recommendation.decision, reason: recommendation.reason,
              requiresAdmission: recommendation.requiresAdmission, consequentialExecutionAuthorized: false,
              observedAt: now
            }, now);
            if (recommendation.requiresAdmission) {
              await this.saveInbox({
                id: inboxObjectId(this.scope, "objective-continuation", continuationId),
                portfolioId: this.scope.portfolioId, companyId: this.scope.companyId,
                environment: this.scope.environment, userId: this.scope.userId,
                objectType: "objective-continuation", objectId: continuationId,
                kind: "recommendation", state: "open",
                summary: "Verified work finished. Review the next governed step: " + recommendation.reason,
                urgency: 0.5, impact: 0.6, confidence: 0.85,
                createdAt: now, updatedAt: now, sensitivity: "internal",
                nextAction: { label: "Review objective", href: `/objectives/${encodeURIComponent(objective.id)}` }
              });
            }
          }
        }
      }
    }
  }
  /** No adapter, broker, policy grant or execution dependency is available to this scheduler. */
  async evaluateScheduled(objective: ObjectiveRecord, metric: ObjectiveMetric, now: string) {
    const previous = (await this.list<ObjectiveEvaluation>("objective-evaluation")).find(e => e.objectiveId === objective.id);
    const connections = (await this.connections()).filter(c => c.status === "healthy"
      && c.grantedUserIds.includes(this.scope.userId) && (!c.expiresAt || Date.parse(c.expiresAt) > Date.parse(now)));
    const evidence = authorizedEvidence(await this.evidence(), this.scope, metric.topic, ["public", "internal"], Date.parse(now))
      .filter(e => connections.some(c => c.id === e.authorization.connectionId && c.resources.includes(e.authorization.resourceId)));
    const dependencyStatuses = Object.fromEntries((await this.list<ObjectiveRecord>("objective"))
      .filter(o => o.portfolioId === this.scope.portfolioId && o.companyId === this.scope.companyId && o.environment === this.scope.environment)
      .map(o => [o.id, o.status]));
    const result = evaluateObjective(this.scope, objective, metric, evidence, now, previous, dependencyStatuses);
    await this.put("objective-evaluation", result.id, result, now);
    await this.saveInbox(evaluationInbox(this.scope, result));
    const evaluations = await this.list<ObjectiveEvaluation>("objective-evaluation");
    for (const outcome of await this.list<VerifiedOutcome>("verified-outcome")) {
      if (outcome.objectiveId !== objective.id || outcome.scope.userId !== this.scope.userId || outcome.objectiveImpact !== null) continue;
      const before = evaluations.filter(e => e.objectiveId === objective.id && e.metricHash === result.metricHash
        && Date.parse(e.observedAt) < Date.parse(outcome.observedAt)).sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
      // Only independently synchronized measurements observed after verification may supply the later measurement.
      if (!before || !result.evidenceIds.length || !result.evidenceIds.every(id => evidence.some(e => e.evidenceId === id
        && Date.parse(e.observedAt) > Date.parse(outcome.observedAt)))) continue;
      const updated = associateMeasuredImpact(outcome, before, result, metric);
      if (updated !== outcome) await this.put("verified-outcome", updated.id,
        { ...updated, portfolioId: this.scope.portfolioId, companyId: this.scope.companyId, environment: this.scope.environment }, now);
    }
    return result;
  }
}
