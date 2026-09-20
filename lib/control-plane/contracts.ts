import type { Decision, DevelopmentEnvelope, Resource } from "@/lib/types";

/**
 * Frontend-facing boundary for the future server-authoritative GetDone Control API.
 * Phase 1 uses development seed data only. Later phases can replace the transport
 * without changing the owner-facing screens.
 */
export interface GetDoneControlPlane {
  listResources(): Promise<DevelopmentEnvelope<Resource[]> | { source: "server"; authoritative: true; data: Resource[] }>;
  listDecisions(): Promise<DevelopmentEnvelope<Decision[]> | { source: "server"; authoritative: true; data: Decision[] }>;
}

export type ControlPlaneErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "POLICY_BLOCKED"
  | "UNAVAILABLE"
  | "VALIDATION_FAILED";

export interface ControlPlaneError {
  code: ControlPlaneErrorCode;
  message: string;
  correlationId?: string;
}
