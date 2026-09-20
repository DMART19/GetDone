import { ControlPlaneError } from "@/lib/control-plane/errors";
import { developmentApiAllowed } from "@/lib/control-plane/runtime-environment";
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
  const allowed = developmentApiAllowed({
    runtimeEnvironment: process.env.GETDONE_RUNTIME_ENV,
    nodeEnvironment: process.env.NODE_ENV,
    dataMode: process.env.GETDONE_DATA_MODE
  });

  if (!allowed) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "Development seed data is disabled outside the development runtime"
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
