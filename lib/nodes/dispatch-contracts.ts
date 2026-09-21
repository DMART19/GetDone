import type { NodeArchitecture } from "@/lib/nodes/contracts";

export const NODE_DISPATCH_CONTRACT_VERSION = "1.0.0";

export interface NodeJobDispatchResourceLimits {
  cpuMillicores: number;
  memoryBytes: number;
  storageBytes?: number;
  gpuIds?: readonly string[];
}

export interface NodeJobDispatch {
  id: string;
  nodeId: string;
  jobId: string;
  reservationId: string;
  authorizationConsumptionHash: string;
  executionSpecHash: string;
  architecture: NodeArchitecture;
  capability: string;
  resourceLimits: NodeJobDispatchResourceLimits;
  createdAt: string;
  expiresAt: string;
  payloadHash: string;
}

export interface NodeDispatchAcknowledgement {
  id: string;
  nodeId: string;
  jobId: string;
  reservationId: string;
  authorizationConsumptionHash: string;
  executionSpecHash: string;
  createdAt: string;
  expiresAt: string;
  accepted: boolean;
  reason?: string;
  payloadHash: string;
}

export interface NodeJobExecutionObservation {
  id: string;
  nodeId: string;
  jobId: string;
  reservationId: string;
  authorizationConsumptionHash: string;
  executionSpecHash: string;
  createdAt: string;
  expiresAt: string;
  state: "accepted" | "starting" | "running" | "completed" | "failed" | "cancelled";
  observedAt: string;
  exitCode?: number;
  payloadHash: string;
}

export interface NodeJobResultSubmission {
  id: string;
  nodeId: string;
  jobId: string;
  reservationId: string;
  authorizationConsumptionHash: string;
  executionSpecHash: string;
  createdAt: string;
  expiresAt: string;
  observedAt: string;
  exitCode: number;
  stdoutReference?: string;
  stderrReference?: string;
  artifactReferences: readonly string[];
  durationMs: number;
  payloadHash: string;
}

export interface NodeReservationAcknowledgement {
  id: string;
  nodeId: string;
  jobId: string;
  reservationId: string;
  authorizationConsumptionHash: string;
  executionSpecHash: string;
  createdAt: string;
  expiresAt: string;
  accepted: boolean;
  reason?: string;
  payloadHash: string;
}

export interface NodeReservationRelease {
  id: string;
  nodeId: string;
  jobId: string;
  reservationId: string;
  authorizationConsumptionHash: string;
  executionSpecHash: string;
  createdAt: string;
  expiresAt: string;
  releasedAt: string;
  payloadHash: string;
}
