import { ControlPlaneError } from "@/lib/control-plane/errors";
import { assertAuthorizationGrantEnvelope, type AuthorizationGrant, type AuthorizationConsumptionRecord } from "@/lib/authorization/grants";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";
import type { AuthoritativeDecision } from "@/lib/domain/decision-service";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";
import { assertTrustedExecutionScopeEqual } from "@/lib/control-plane/trusted-execution-scope";
import { OperationalStore } from "./store.server";
import { capabilityMap } from "./capability-map";
import { createExecutionPreview } from "./preview";
import type { PreviewAuthority } from "./n8n-adapter";

export async function resolvePreviewAuthority(db: SqlQueryable, request: AuthorizedBusinessActionRequest): Promise<PreviewAuthority> {
  const result = await db.query<{ decision: AuthoritativeDecision; grant: AuthorizationGrant; consumption: AuthorizationConsumptionRecord; job: JobRecord }>(
    `SELECT d.payload AS decision,g.payload AS grant,c.payload AS consumption,j.payload AS job
     FROM authorization_consumptions c JOIN authorization_grants g ON g.id=c.grant_id
     JOIN control_plane_entities d ON d.entity_type='decision' AND d.id=g.payload->>'decisionId'
     JOIN control_plane_entities j ON j.entity_type='job' AND j.id=$1
     WHERE c.consumption_hash=$2 AND g.portfolio_id=$3 AND g.company_id=$4 AND g.status='active'
       AND d.portfolio_id=g.portfolio_id AND d.company_id=g.company_id
       AND j.portfolio_id=g.portfolio_id AND j.company_id=g.company_id`,
    [request.jobId, request.authorizationConsumptionHash, request.scope.portfolioId, request.scope.companyId]);
  const row = result.rows[0];
  if (!row?.decision.executionPreview || !row.decision.approvalProof || row.decision.status !== "approved"
    || row.job.authorizationGrantId !== row.grant.id || row.job.taskId !== row.consumption.consumerId
    || row.grant.approvalProofHash !== row.decision.approvalProof.proofHash
    || row.consumption.consumptionHash !== request.authorizationConsumptionHash)
    throw new ControlPlaneError("FORBIDDEN", "n8n dispatch requires an approved persisted preview and the job's native authorization consumption");
  assertAuthorizationGrantEnvelope(row.grant, request.scope);
  assertTrustedExecutionScopeEqual(request.scope, row.grant.scope, { requireSameResource: Boolean(request.scope.resourceId) });
  const preview = row.decision.executionPreview;
  const store = new OperationalStore(db, request.scope);
  const registration = capabilityMap(request.scope, await store.connections(), Date.now()).find(v =>
    v.workflow === preview.workflow && v.connectionId === (request.input as { connectionId?: string }).connectionId);
  if (!registration) throw new ControlPlaneError("UNAVAILABLE", "The approved n8n connection is unavailable");
  const currentPreview = createExecutionPreview({ scope: request.scope, registration, parameters: request.input,
    policy: { disposition: preview.approval, artifactHash: preview.policyHash, planHash: row.grant.planHash, stepHash: row.grant.stepHash },
    now: preview.createdAt, expiresAt: preview.expiresAt, estimatedCostCents: preview.estimatedCostCents });
  return { preview, currentPreview, proof: row.decision.approvalProof, stepUpProof: row.decision.stepUpProof };
}
