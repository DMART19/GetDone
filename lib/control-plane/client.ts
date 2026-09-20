import type { GetDoneControlPlane } from "@/lib/control-plane/contracts";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { ApiEnvelope } from "@/lib/control-plane/schemas";
import type { Decision, Resource } from "@/lib/types";

function isApiEnvelope<T>(value: unknown): value is ApiEnvelope<T> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.ok === "boolean"
    && typeof candidate.correlationId === "string"
    && (candidate.environment === "development"
      || candidate.environment === "staging"
      || candidate.environment === "production");
}

async function getEnvelope<T>(path: string): Promise<ApiEnvelope<T>> {
  const response = await fetch(path, {
    cache: "no-store",
    headers: { accept: "application/json" }
  });

  const value: unknown = await response.json().catch(() => null);
  if (!isApiEnvelope<T>(value)) {
    throw new ControlPlaneError("UNAVAILABLE", "Control API returned an invalid response envelope");
  }

  if (!response.ok && value.ok) {
    throw new ControlPlaneError("UNAVAILABLE", "Control API returned an inconsistent success response", {
      correlationId: value.correlationId
    });
  }

  return value;
}

export const developmentControlPlane: GetDoneControlPlane = {
  listResources: () => getEnvelope<Resource[]>("/api/dev/resources"),
  listDecisions: () => getEnvelope<Decision[]>("/api/dev/decisions")
};
