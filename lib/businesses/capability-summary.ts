import type { BusinessContext, BusinessSection } from "./contracts";

export type CapabilityState = "available" | "degraded" | "blocked" | "unknown";
export interface BusinessCapability {
  section: BusinessSection;
  title: string;
  state: CapabilityState;
  reason: string;
  recordCount: number;
}

const names: Record<BusinessSection, string> = {
  objectives: "Planning & objectives",
  integrations: "Business integrations",
  signals: "Signal investigation",
  decisions: "Owner approvals",
  jobs: "Worker execution",
  outcomes: "Outcome evidence"
};

const blocking = new Set(["failed", "blocked", "revoked", "disabled", "unreachable", "quarantined"]);
const degraded = new Set(["degraded", "stalled", "retrying", "pending", "expired"]);

export function summarizeBusinessCapabilities(context: BusinessContext): BusinessCapability[] {
  return (Object.keys(names) as BusinessSection[]).map(section => {
    const source = context.sections[section];
    const records = source.records;
    // A record's presence is NOT proof that its external connector or worker is online.
    if (section === "signals" && records.length === 0) {
      return { section, title: names[section], state: "unknown", reason: source.note || "No connected signal feed is evidenced.", recordCount: 0 };
    }
    if (!records.length) {
      return { section, title: names[section], state: "unknown", reason: `No ${section} records are available to verify this capability.`, recordCount: 0 };
    }
    const states = records.map(record => record.status.toLowerCase());
    const hasBlocked = states.some(state => blocking.has(state));
    const hasDegraded = states.some(state => degraded.has(state));
    const state: CapabilityState = hasBlocked ? "blocked" : hasDegraded ? "degraded" : "unknown";
    const reason = hasBlocked
      ? "One or more recorded items are blocked or failed. Inspect the source records."
      : hasDegraded
        ? "One or more recorded items need review. Record health is not independently verified."
        : "Records exist, but live execution/connection health has not been independently verified.";
    return { section, title: names[section], state, reason, recordCount: records.length };
  });
}
