import { ControlPlaneError } from "@/lib/control-plane/errors";
import { decisions, getDecision, getResource, resourceSummary, resources } from "@/lib/mock-data";
import type { Decision, Resource } from "@/lib/types";

export interface OwnerReadRepository {
  listDecisions(): Promise<readonly Decision[]>;
  getDecision(id: string): Promise<Decision | null>;
  listResources(): Promise<readonly Resource[]>;
  getResource(id: string): Promise<Resource | null>;
  getResourceSummary(): Promise<typeof resourceSummary>;
}

function assertDevelopmentSeedAllowed() {
  const appEnvironment = process.env.NEXT_PUBLIC_APP_ENV ?? "development";
  const dataMode = process.env.GETDONE_DATA_MODE ?? "development-seed";

  if (appEnvironment === "production" && dataMode === "development-seed") {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "Development seed data is disabled for the production owner surface"
    );
  }
}

export const developmentOwnerRepository: OwnerReadRepository = {
  async listDecisions() {
    assertDevelopmentSeedAllowed();
    return decisions;
  },
  async getDecision(id) {
    assertDevelopmentSeedAllowed();
    return getDecision(id) ?? null;
  },
  async listResources() {
    assertDevelopmentSeedAllowed();
    return resources;
  },
  async getResource(id) {
    assertDevelopmentSeedAllowed();
    return getResource(id) ?? null;
  },
  async getResourceSummary() {
    assertDevelopmentSeedAllowed();
    return resourceSummary;
  }
};
