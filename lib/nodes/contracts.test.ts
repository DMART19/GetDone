import { describe, expect, it } from "vitest";
import {
  NODE_AGENT_PROTOCOL_VERSION,
  NODE_DOMAIN_VERSION,
  type NodeArchitecture,
  type NodeRecord
} from "@/lib/nodes/contracts";
import { NODE_DISPATCH_CONTRACT_VERSION } from "@/lib/nodes/dispatch-contracts";

describe("Phase 28 node contracts", () => {
  it("pins the domain, agent protocol, and dispatch contract versions", () => {
    expect(NODE_DOMAIN_VERSION).toBe("1.0.0");
    expect(NODE_AGENT_PROTOCOL_VERSION).toBe("1.0.0");
    expect(NODE_DISPATCH_CONTRACT_VERSION).toBe("1.0.0");
  });

  it.each<NodeArchitecture>(["x86_64", "arm64"])(
    "models %s as a first-class Linux architecture",
    (architecture) => {
      const node: NodeRecord = {
        id: "node-1",
        portfolioId: "portfolio-a",
        companyId: "company-a",
        resourceId: "resource-1",
        displayName: "compute-node",
        platform: "linux",
        architecture,
        agentVersion: "0.1.0",
        protocolVersion: NODE_AGENT_PROTOCOL_VERSION,
        state: "identified",
        trustClass: "untrusted",
        environmentPermissions: ["development"],
        failureDomainIds: [],
        policyBindingIds: [],
        credentialBindingIds: [],
        capabilityProfileId: "capability-profile-1",
        allocatableProfileId: "allocatable-profile-1",
        createdAt: "2026-09-21T12:00:00Z",
        updatedAt: "2026-09-21T12:00:00Z",
        version: 1
      };
      expect(node.architecture).toBe(architecture);
      expect(node.platform).toBe("linux");
    }
  );
});
