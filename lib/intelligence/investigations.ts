import type { SignalClass, SensedSignal, TrustedSignalScope } from "@/lib/intelligence/signals";

export type InvestigationState = "open" | "monitoring" | "resolved" | "dismissed";

export interface Investigation {
  id: string;
  key: string;
  portfolioId: string;
  companyId: string;
  resourceId?: string;
  signalType: string;
  state: InvestigationState;
  severity: SignalClass;
  action: "INVESTIGATE" | "ESCALATE";
  signalIds: readonly string[];
  reason: string;
  openedAt: string;
  lastSignalAt: string;
  cooldownUntil: string;
  version: number;
}

export interface InvestigationStore {
  findLatestByKey(key: string): Promise<Investigation | null>;
  create(investigation: Investigation): Promise<void>;
  appendSignal(input: {
    investigationId: string;
    signalId: string;
    lastSignalAt: string;
    severity: SignalClass;
    action: "INVESTIGATE" | "ESCALATE";
    expectedVersion: number;
  }): Promise<Investigation>;
}

export function investigationKey(scope: TrustedSignalScope, signalType: string) {
  return [scope.portfolioId, scope.companyId, scope.resourceId ?? "-", signalType].join(":");
}

export interface InvestigationCreationPolicy {
  cooldownSeconds: number;
}

export type InvestigationResult =
  | { status: "not-required" }
  | { status: "created"; investigation: Investigation }
  | { status: "updated"; investigation: Investigation }
  | { status: "cooldown-suppressed"; investigation: Investigation };

export class InvestigationCoordinator {
  constructor(
    private readonly store: InvestigationStore,
    private readonly idFactory: () => string = () => crypto.randomUUID()
  ) {}

  async consider(
    signal: SensedSignal,
    policy: InvestigationCreationPolicy,
    now = new Date()
  ): Promise<InvestigationResult> {
    if (signal.action !== "INVESTIGATE" && signal.action !== "ESCALATE") {
      return { status: "not-required" };
    }

    const key = investigationKey(signal.scope, signal.type);
    const latest = await this.store.findLatestByKey(key);

    if (latest && (latest.state === "open" || latest.state === "monitoring")) {
      const updated = await this.store.appendSignal({
        investigationId: latest.id,
        signalId: signal.id,
        lastSignalAt: signal.occurredAt,
        severity: signal.classification,
        action: signal.action,
        expectedVersion: latest.version
      });
      return { status: "updated", investigation: updated };
    }

    if (
      latest
      && signal.action !== "ESCALATE"
      && Date.parse(latest.cooldownUntil) > now.getTime()
    ) {
      return { status: "cooldown-suppressed", investigation: latest };
    }

    const openedAt = now.toISOString();
    const investigation: Investigation = {
      id: this.idFactory(),
      key,
      portfolioId: signal.scope.portfolioId,
      companyId: signal.scope.companyId,
      resourceId: signal.scope.resourceId,
      signalType: signal.type,
      state: "open",
      severity: signal.classification,
      action: signal.action,
      signalIds: [signal.id],
      reason: signal.rationale.join("; "),
      openedAt,
      lastSignalAt: signal.occurredAt,
      cooldownUntil: new Date(now.getTime() + policy.cooldownSeconds * 1000).toISOString(),
      version: 1
    };

    await this.store.create(investigation);
    return { status: "created", investigation };
  }
}
