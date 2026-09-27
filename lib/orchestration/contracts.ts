import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { GetDoneEnvironment, TrustedActor } from "@/lib/control-plane/request-context";

export const ORCHESTRATION_RUNTIME_CONTRACT_VERSION = "1.0.0";

export const ORCHESTRATION_RUN_STATES = Object.freeze([
  "received",
  "context-building",
  "planning",
  "validating",
  "policy-evaluation",
  "awaiting-approval",
  "authorized",
  "materializing",
  "queued",
  "executing",
  "verifying",
  "succeeded",
  "blocked",
  "failed",
  "cancelled",
  "replan-required"
] as const);

export type OrchestrationRunState = (typeof ORCHESTRATION_RUN_STATES)[number];

export type OrchestrationSource =
  | Readonly<{ kind: "owner-intent"; ownerIntentId: string }>
  | Readonly<{ kind: "investigation"; investigationId: string; signalIds: readonly string[] }>
  | Readonly<{ kind: "objective"; objectiveId: string }>;

export interface OrchestrationRun {
  id: string;
  correlationId: string;
  portfolioId: string;
  companyId: string;
  environment: GetDoneEnvironment;
  authorityUserId: string;
  initiatingActor: TrustedActor;
  source: OrchestrationSource;
  state: OrchestrationRunState;
  attempt: number;
  version: number;
  availableAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestrationQueueEvent {
  id: string;
  correlationId: string;
  portfolioId: string;
  companyId: string;
  eventType: "orchestration.triggered" | "orchestration.resume";
  runId: string;
  occurredAt: string;
  availableAt: string;
  claimedBy?: string;
  claimedUntil?: string;
  deliveredAt?: string;
  attempts: number;
  lastError?: string;
}

export interface ClaimedOrchestrationRun {
  event: OrchestrationQueueEvent;
  run: OrchestrationRun;
}

export const ORCHESTRATION_TERMINAL_STATES = Object.freeze([
  "succeeded",
  "blocked",
  "failed",
  "cancelled"
] as const satisfies readonly OrchestrationRunState[]);

const transitionMap: Readonly<Record<OrchestrationRunState, readonly OrchestrationRunState[]>> =
  Object.freeze({
    "received": Object.freeze(["context-building", "blocked", "failed", "cancelled"]),
    "context-building": Object.freeze(["planning", "blocked", "failed", "cancelled"]),
    "planning": Object.freeze(["validating", "blocked", "failed", "cancelled"]),
    "validating": Object.freeze(["policy-evaluation", "replan-required", "blocked", "failed", "cancelled"]),
    "policy-evaluation": Object.freeze([
      "awaiting-approval",
      "authorized",
      "replan-required",
      "blocked",
      "failed",
      "cancelled"
    ]),
    "awaiting-approval": Object.freeze([
      "authorized",
      "replan-required",
      "blocked",
      "failed",
      "cancelled"
    ]),
    "authorized": Object.freeze(["materializing", "replan-required", "blocked", "failed", "cancelled"]),
    "materializing": Object.freeze(["queued", "replan-required", "failed", "cancelled"]),
    "queued": Object.freeze(["executing", "verifying", "failed", "cancelled"]),
    "executing": Object.freeze(["verifying", "replan-required", "failed", "cancelled"]),
    "verifying": Object.freeze(["succeeded", "replan-required", "blocked", "failed", "cancelled"]),
    "replan-required": Object.freeze(["planning", "blocked", "failed", "cancelled"]),
    "succeeded": Object.freeze([]),
    "blocked": Object.freeze([]),
    "failed": Object.freeze([]),
    "cancelled": Object.freeze([])
  });

export function isTerminalOrchestrationState(state: OrchestrationRunState) {
  return (ORCHESTRATION_TERMINAL_STATES as readonly OrchestrationRunState[]).includes(state);
}

export function assertOrchestrationTransition(
  from: OrchestrationRunState,
  to: OrchestrationRunState
) {
  if (!transitionMap[from].includes(to)) {
    throw new ControlPlaneError(
      "CONFLICT",
      `Invalid orchestration transition: ${from} -> ${to}`
    );
  }
}

export function orchestrationSourceIdentity(source: OrchestrationSource) {
  switch (source.kind) {
    case "owner-intent":
      return Object.freeze({ kind: source.kind, id: source.ownerIntentId });
    case "investigation":
      return Object.freeze({ kind: source.kind, id: source.investigationId });
    case "objective":
      return Object.freeze({ kind: source.kind, id: source.objectiveId });
  }
}

export function orchestrationRunId(source: OrchestrationSource) {
  const identity = orchestrationSourceIdentity(source);
  return `orchestration:${identity.kind}:${identity.id}`;
}

export function orchestrationTriggerEventId(runId: string) {
  return `outbox:orchestration.triggered:${runId}`;
}

export function orchestrationResumeEventId(runId: string, version: number) {
  return `outbox:orchestration.resume:${runId}:v${version}`;
}
