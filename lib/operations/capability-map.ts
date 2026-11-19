import { connectionSchema, type OperationalConnection, type OperationScope, type NarrowWorkflow } from "./contracts";
import { getCapability } from "@/lib/domain/capabilities";
import type { PolicyDisposition } from "@/lib/planning/policy-engine";

export const narrowCapabilities = Object.freeze([
  { workflow: "github_repository_health", capability: "github.repository.read", provider: "github", action: false, approval: "AUTO" },
  { workflow: "deployment_health", capability: "http.request", provider: "deployment", action: false, approval: "AUTO" },
  { workflow: "github_create_branch", capability: "github.branch.create", provider: "github", action: true, approval: "APPROVAL_REQUIRED" }
] as const);
export interface CapabilityView {
  provider: "github" | "deployment";
  workflow: NarrowWorkflow; capability: string; connectionId?: string; companyId: string; resources: readonly string[];
  action: boolean; approval: PolicyDisposition; status: "available" | "missing" | "disabled" | "degraded" | "blocked";
  requirement?: string;
}
export function capabilityMap(scope: OperationScope, connections: readonly OperationalConnection[], now: number): CapabilityView[] {
  const authorized = connections.filter(c => connectionSchema.safeParse(c).success && c.portfolioId === scope.portfolioId
    && c.companyId === scope.companyId && c.environment === scope.environment && c.grantedUserIds.includes(scope.userId)
    && (!scope.resourceId || c.resources.includes(scope.resourceId)));
  return narrowCapabilities.flatMap(registration => {
    const matches = authorized.filter(c => c.provider === registration.provider && c.workflows.includes(registration.workflow));
    return (matches.length ? matches : [undefined]).map(c => {
      const enabled = getCapability(registration.capability)?.enabled;
      const status = !enabled || c?.status === "disabled" ? "disabled" : c?.status === "blocked" ? "blocked"
        : !c ? "missing" : c.status !== "healthy" || (c.expiresAt && Date.parse(c.expiresAt) <= now) ? "degraded" : "available";
      return { ...registration, companyId: scope.companyId, connectionId: c?.id, resources: c ? (scope.resourceId ? [scope.resourceId] : c.resources) : [], status,
        requirement: status === "available" ? undefined : `${registration.provider} connection with ${registration.action ? "branch-create and repository-read" : "read"} access to an allowlisted resource for this business (${registration.workflow})` };
    });
  });
}
export function connectionRequirement(topic: string | null | undefined, views: readonly CapabilityView[]): string {
  if (topic === "revenue") return "Connect a read-only revenue source for this business with dated gross/net revenue, reporting period and currency. GitHub and deployment connections cannot answer revenue questions; revenue synchronization is outside this release.";
  const matching = views.filter(v => !v.action && (topic !== "deployment" || v.workflow === "deployment_health"));
  return matching.filter(v => v.status !== "available").map(v => v.requirement).filter(Boolean).join("; ")
    || "The connection is available, but fresh authorized evidence for this business and topic has not been synchronized.";
}
