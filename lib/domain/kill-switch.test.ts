import { describe, expect, it } from "vitest";
import {
  blockingKillSwitches,
  isNewWorkBlocked,
  type KillSwitch,
  type KillSwitchScope
} from "@/lib/domain/kill-switch";

const work = {
  portfolioId: "portfolio-1",
  companyId: "company-1",
  integrationId: "integration-1",
  capability: "email.send",
  resourceId: "resource-1",
  poolId: "pool-1",
  providerId: "provider-1",
  failureDomainId: "domain-1",
  workloadClass: "coding"
};

const scopeIds: Record<KillSwitchScope, string> = {
  global: "global",
  portfolio: work.portfolioId,
  company: work.companyId,
  integration: work.integrationId,
  capability: work.capability,
  resource: work.resourceId,
  pool: work.poolId,
  provider: work.providerId,
  "failure-domain": work.failureDomainId,
  "workload-class": work.workloadClass
};

function killSwitch(scopeType: KillSwitchScope, overrides: Partial<KillSwitch> = {}): KillSwitch {
  return {
    id: `kill-${scopeType}`,
    scopeType,
    scopeId: scopeIds[scopeType],
    enabled: true,
    reason: "test",
    activatedAt: "2026-09-20T20:00:00Z",
    activatedBy: "owner",
    ...overrides
  };
}

describe("kill-switch scope matching", () => {
  it("blocks work for every supported matching authority scope", () => {
    const switches = (Object.keys(scopeIds) as KillSwitchScope[]).map((scope) => killSwitch(scope));
    const blocked = blockingKillSwitches(switches, work);
    expect(blocked.map((item) => item.scopeType).sort()).toEqual(
      (Object.keys(scopeIds) as KillSwitchScope[]).sort()
    );
    expect(isNewWorkBlocked(switches, work)).toBe(true);
  });

  it("ignores disabled and nonmatching switches", () => {
    const switches = [
      killSwitch("global", { enabled: false }),
      killSwitch("portfolio", { scopeId: "other-portfolio" }),
      killSwitch("company", { scopeId: "other-company" }),
      killSwitch("integration", { scopeId: "other-integration" }),
      killSwitch("capability", { scopeId: "other.capability" }),
      killSwitch("resource", { scopeId: "other-resource" }),
      killSwitch("pool", { scopeId: "other-pool" }),
      killSwitch("provider", { scopeId: "other-provider" }),
      killSwitch("failure-domain", { scopeId: "other-domain" }),
      killSwitch("workload-class", { scopeId: "other-class" })
    ];
    expect(blockingKillSwitches(switches, work)).toEqual([]);
    expect(isNewWorkBlocked(switches, work)).toBe(false);
  });
});
