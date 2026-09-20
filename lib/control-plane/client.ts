import type { Decision, DevelopmentEnvelope, Resource } from "@/lib/types";

async function getDevelopmentSeed<T>(path: string): Promise<DevelopmentEnvelope<T>> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Development data unavailable (${response.status})`);
  }
  return response.json() as Promise<DevelopmentEnvelope<T>>;
}

export const developmentControlPlane = {
  listResources: () => getDevelopmentSeed<Resource[]>("/api/dev/resources"),
  listDecisions: () => getDevelopmentSeed<Decision[]>("/api/dev/decisions")
};
