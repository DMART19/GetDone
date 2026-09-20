export type KillSwitchScope =
  | "global"
  | "portfolio"
  | "company"
  | "integration"
  | "capability"
  | "resource"
  | "pool"
  | "provider"
  | "failure-domain"
  | "workload-class";

export interface KillSwitch {
  id: string;
  scopeType: KillSwitchScope;
  scopeId: string;
  enabled: boolean;
  reason: string;
  activatedAt: string;
  activatedBy: string;
}

export interface WorkAdmission {
  portfolioId: string;
  companyId: string;
  integrationId?: string;
  capability?: string;
  resourceId?: string;
  poolId?: string;
  providerId?: string;
  failureDomainId?: string;
  workloadClass?: string;
}

function matches(killSwitch: KillSwitch, work: WorkAdmission) {
  if (!killSwitch.enabled) return false;

  switch (killSwitch.scopeType) {
    case "global":
      return killSwitch.scopeId === "global";
    case "portfolio":
      return killSwitch.scopeId === work.portfolioId;
    case "company":
      return killSwitch.scopeId === work.companyId;
    case "integration":
      return killSwitch.scopeId === work.integrationId;
    case "capability":
      return killSwitch.scopeId === work.capability;
    case "resource":
      return killSwitch.scopeId === work.resourceId;
    case "pool":
      return killSwitch.scopeId === work.poolId;
    case "provider":
      return killSwitch.scopeId === work.providerId;
    case "failure-domain":
      return killSwitch.scopeId === work.failureDomainId;
    case "workload-class":
      return killSwitch.scopeId === work.workloadClass;
  }
}

export function blockingKillSwitches(
  killSwitches: readonly KillSwitch[],
  work: WorkAdmission
) {
  return killSwitches.filter((killSwitch) => matches(killSwitch, work));
}

export function isNewWorkBlocked(
  killSwitches: readonly KillSwitch[],
  work: WorkAdmission
) {
  return blockingKillSwitches(killSwitches, work).length > 0;
}
