import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it
} from "vitest";
import type {
  NodeCapability,
  NodeCapabilityProfile
} from "@/lib/nodes/contracts";
import {
  hashNodeCapability,
  hashNodeCapabilityProfile
} from "@/lib/nodes/hashes";
import {
  handleNodeCapabilities
} from "@/lib/nodes/capability-http";
import {
  installNodeAgentAuthenticator,
  resetNodeAgentAuthenticator
} from "@/lib/nodes/agent-runtime.server";
import {
  installNodeCapabilityAdapter,
  resetNodeCapabilityAdapter
} from "@/lib/nodes/capability-runtime.server";

function profile(): NodeCapabilityProfile {
  const capabilityBase: Omit<NodeCapability, "capabilityHash"> = {
    id: "node-capability-runtime-python",
    nodeId: "node-1",
    name: "runtime.python",
    version: "Python 3.12.7",
    status: "validated",
    evidenceIds: ["cap-evidence-python"],
    constraints: { runtime: "python3" },
    observedAt: "2026-09-21T18:00:00Z"
  };
  const capability: NodeCapability = {
    ...capabilityBase,
    capabilityHash: hashNodeCapability(capabilityBase)
  };
  const base: Omit<NodeCapabilityProfile, "profileHash"> = {
    nodeId: "node-1",
    observedAt: "2026-09-21T18:00:00Z",
    capabilities: [capability]
  };
  return {
    ...base,
    profileHash: hashNodeCapabilityProfile(base)
  };
}

function request(body: unknown, withKey = true) {
  const headers = new Headers({ "content-type": "application/json" });
  if (withKey) headers.set("idempotency-key", "capability-profile-1");
  return new Request("http://localhost/api/agent/v1/capabilities", {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  process.env.GETDONE_RUNTIME_ENV = "development";
});

afterEach(() => {
  delete process.env.GETDONE_RUNTIME_ENV;
  resetNodeAgentAuthenticator();
  resetNodeCapabilityAdapter();
});

describe("Node capability HTTP boundary", () => {
  it("fails closed while authenticated Node transport is unconnected", async () => {
    const response = await handleNodeCapabilities(request(profile()));
    expect(response.status).toBe(503);
  });

  it("requires idempotency on capability profile mutation", async () => {
    installNodeAgentAuthenticator({
      authenticate: async () => ({
        nodeId: "node-1",
        portfolioId: "portfolio-a",
        companyId: "company-a",
        credentialId: "credential-1"
      })
    });
    const response = await handleNodeCapabilities(request(profile(), false));
    expect(response.status).toBe(400);
  });

  it("submits only after authenticated Node identity is resolved", async () => {
    installNodeAgentAuthenticator({
      authenticate: async () => ({
        nodeId: "node-1",
        portfolioId: "portfolio-a",
        companyId: "company-a",
        credentialId: "credential-1"
      })
    });
    let received: NodeCapabilityProfile | undefined;
    installNodeCapabilityAdapter({
      submit: async (_principal, value) => {
        received = value;
        return {
          profile: {
            id: "record-1",
            nodeId: value.nodeId,
            portfolioId: "portfolio-a",
            companyId: "company-a",
            profileHash: value.profileHash,
            observedAt: value.observedAt,
            receivedAt: "2026-09-21T18:00:05Z",
            profile: value
          },
          currentCapabilities: value.capabilities,
          removedCapabilities: [],
          replay: false
        };
      }
    });
    const response = await handleNodeCapabilities(request(profile()));
    expect(response.status).toBe(201);
    expect(received?.nodeId).toBe("node-1");
  });

  it("rejects duplicate capability names at schema boundary", async () => {
    installNodeAgentAuthenticator({
      authenticate: async () => ({
        nodeId: "node-1",
        portfolioId: "portfolio-a",
        companyId: "company-a",
        credentialId: "credential-1"
      })
    });
    const valid = profile();
    const duplicate = {
      ...valid,
      capabilities: [valid.capabilities[0], valid.capabilities[0]]
    };
    const response = await handleNodeCapabilities(request(duplicate));
    expect(response.status).toBe(400);
  });
});
