import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";
import { OperationalStore } from "./store.server";
import { normalizeEvidence } from "./evidence";
export async function markConnectionDegraded(db: SqlQueryable, request: AuthorizedBusinessActionRequest, connectionId: string) {
  const store = new OperationalStore(db, request.scope);
  const connection = (await store.connections()).find(c => c.id === connectionId && c.grantedUserIds.includes(request.scope.userId));
  if (!connection || connection.status !== "healthy") return;
  const now = new Date().toISOString();
  // Update health only: concurrent grant revocation or operator blocking must not be overwritten.
  await db.query(`UPDATE control_plane_entities SET
    payload=jsonb_set(jsonb_set(payload,'{status}','"degraded"'::jsonb),'{updatedAt}',to_jsonb($5::text)),
    updated_at=$5::timestamptz,version=version+1
    WHERE entity_type='operational-connection' AND portfolio_id=$1 AND company_id=$2
    AND payload->>'environment'=$3 AND payload->>'id'=$4 AND payload->>'status'='healthy'`,
    [request.scope.portfolioId, request.scope.companyId, request.scope.environment, connection.id, now]);
  await store.refreshInbox(now);
}
export async function synchronizeProviderRead(db: SqlQueryable, request: AuthorizedBusinessActionRequest, output: unknown) {
  const store = new OperationalStore(db, request.scope);
  const input = request.input as { repository?: string; operation?: string; connectionId?: string };
  const resource = input.repository ?? input.operation;
  const connection = (await store.connections()).find(c => c.status === "healthy" && c.grantedUserIds.includes(request.scope.userId)
    && c.resources.includes(resource ?? "") && (!input.connectionId || c.id === input.connectionId)
    && (!c.expiresAt || Date.parse(c.expiresAt) > Date.now()));
  if (!connection || !resource) throw new ControlPlaneError("FORBIDDEN", "Provider synchronization requires a current scoped connection and resource allowlist");
  const value = output as { data?: Record<string, unknown>; facts?: Record<string, unknown>; observedAt?: string };
  const facts: Record<string, string | number | boolean | null> = {};
  for (const [key, v] of Object.entries(value.facts ?? value.data ?? {})) {
    if (["open_issues_count", "archived", "default_branch", "pushed_at", "status", "failures", "responseStatus", "sourceSha", "sourceBranch"].includes(key)
      && (v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))) facts[key] = v;
  }
  const observedAt = new Date().toISOString();
  const evidence = normalizeEvidence({ evidenceId: `provider-read:${sha256Hex({ scope: request.scope, resource, output })}`,
    portfolioId: request.scope.portfolioId, companyId: request.scope.companyId, environment: request.scope.environment,
    topic: "deployment", sourceType: connection.provider, sourceRef: resource, observedAt,
    freshUntil: new Date(Date.parse(observedAt) + 15 * 60_000).toISOString(), sensitivity: "internal",
    summary: `${connection.provider} health for ${resource}: ${facts.status ?? (facts.archived === true ? "archived" : "read completed; inspect supporting facts")}`,
    facts, confidence: Object.keys(facts).length ? 0.85 : 0.5,
    deepLink: input.repository ? `https://github.com/${input.repository}` : undefined,
    authorization: { connectionId: connection.id, resourceId: resource, grantedUserIds: connection.grantedUserIds,
      provenanceRef: `provider-read:${request.id}:${request.inputHash}`, authorizedAt: observedAt } });
  await store.saveEvidence(evidence);
}
