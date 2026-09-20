export type ResourceKind = "compute" | "storage" | "network" | "cloud" | "partner" | "other";
export type ResourceHealth = "healthy" | "online" | "degraded" | "offline";

export interface Resource {
  id: string;
  name: string;
  role: string;
  kind: ResourceKind;
  health: ResourceHealth;
  provider: string;
  location: string;
  environments: string[];
  customerDataPolicy: string;
  reliabilityTier: string;
  autoScheduling: boolean;
  metrics: Array<{ label: string; value: string; tone?: "good" | "neutral" }>;
  workloads: { running: number; queued: number; utilization: number };
  icon: "server" | "gpu" | "storage" | "cloud" | "network";
}

export type DecisionPriority = "high" | "normal" | "fyi";
export type DecisionStatus = "pending" | "approved" | "modified" | "rejected";

export interface Decision {
  id: string;
  title: string;
  subtitle: string;
  priority: DecisionPriority;
  age: string;
  category: "resource" | "growth" | "incident" | "budget" | "outreach";
  status: DecisionStatus;
  rationale: string;
  impact: string[];
}

export interface DevelopmentEnvelope<T> {
  source: "development-seed";
  authoritative: false;
  data: T;
}
