import type { ApiEnvelope } from "@/lib/control-plane/schemas";
import type { Decision, Resource } from "@/lib/types";

/**
 * Frontend-facing transport contract for the GetDone-owned Control API.
 * Implementations may use DEVELOPMENT seed routes or later authenticated
 * server-authoritative routes, but owner-facing components should not depend
 * on provider-specific SDKs.
 */
export interface GetDoneControlPlane {
  listResources(): Promise<ApiEnvelope<Resource[]>>;
  listDecisions(): Promise<ApiEnvelope<Decision[]>>;
}
