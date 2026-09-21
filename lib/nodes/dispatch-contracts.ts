import type { NodeArchitecture, NodeResourceUsage } from "@/lib/nodes/contracts";

export const NODE_DISPATCH_CONTRACT_VERSION = "1.0.0";

export interface NodeAuthoritativeEnvelopeLineage {
  id: string;
  nodeId: string;
  jobId: string;
  reservationId: string;
  authorizationConsumptionHash: string;
  executionSpecHash: string;
  createdAt: string;
  expiresAt: string;
  payloadHash: string;
}

export interface NodeJobDispatchResourceLimits {
  cpuMillicores: number;
  memoryBytes: number;
  storageBytes?: number;
  gpuIds?: readonly string[];
  maxPids?: number;
}

export interface NodeJobDispatch extends NodeAuthoritativeEnvelopeLineage {
  architecture: NodeArchitecture;
  capability: string;
  resourceLimits: NodeJobDispatchResourceLimits;
  workloadReference: string;
  timeoutSeconds: number;
}

export interface NodeDispatchAcknowledgement extends NodeAuthoritativeEnvelopeLineage {
  dispatchId: string;
  accepted: boolean;
  reason?: string;
  observedAt: string;
}

export interface NodeJobExecutionObservation extends NodeAuthoritativeEnvelopeLineage {
  dispatchId: string;
  state: "received" | "prepared" | "running" | "cancelling" | "completed" | "failed";
  observedAt: string;
  resourceUsage?: NodeResourceUsage;
  localExecutionId?: string;
}

export interface NodeJobResultSubmission extends NodeAuthoritativeEnvelopeLineage {
  dispatchId: string;
  localExecutionId: string;
  exitCode?: number;
  outcome: "completed" | "failed" | "cancelled" | "timed-out";
  stdoutReference?: string;
  stderrReference?: string;
  artifactReferences: readonly string[];
  resourceUsage: NodeResourceUsage;
  observedAt: string;
}

export interface NodeReservationAcknowledgement extends NodeAuthoritativeEnvelopeLineage {
  accepted: boolean;
  reason?: string;
  observedAt: string;
}

export interface NodeReservationRelease extends NodeAuthoritativeEnvelopeLineage {
  reason: string;
  observedAt: string;
}
