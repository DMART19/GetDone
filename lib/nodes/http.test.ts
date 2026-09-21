import { afterEach, describe, expect, it } from "vitest";
import {
  handleAgentNodeEnrollment,
  handleCreateNodeEnrollment,
  handleGetNodeEnrollment,
  handleNodeEnrollmentAction
} from "@/lib/nodes/http";
import {
  installNodeEnrollmentAdapter,
  resetNodeEnrollmentAdapter
} from "@/lib/nodes/runtime.server";
import {
  installControlApiAdapter,
  resetControlApiAdapter
} from "@/lib/control-api/runtime.server";
import type {
  ControlApiApplicationAdapter,
  ControlApiPrincipal
} from "@/lib/control-api/contracts";
import type {
  CreateNodeEnrollmentInput,
  NodeEnrollmentApplicationAdapter
} from "@/lib/nodes/application";

const principal: ControlApiPrincipal = {
  actor: { type: "user", id: "owner-a" },
  scope: {
    userId: "owner-a",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "development"
  },
  sessionId: "session-a"
};

function installOwnerAuth() {
  installControlApiAdapter({
    authenticate: async () => principal
  } as unknown as ControlApiApplicationAdapter);
}

function jsonRequest(
  url: string,
  body: unknown,
  idempotencyKey?: string
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

afterEach(() => {
  resetNodeEnrollmentAdapter();
  resetControlApiAdapter();
});

describe("Phase 28.2 Node enrollment HTTP surface", () => {
  it("fails closed when the Node enrollment adapter is unconnected", async () => {
    const response = await handleAgentNodeEnrollment(jsonRequest(
      "http://localhost/api/agent/v1/enroll",
      {
        enrollmentToken: "bootstrap-token-that-is-long-enough",
        agentVersion: "0.2.0",
        protocolVersion: "1.0.0",
        architecture: "x86_64",
        bootstrapPublicKey: "public-key-material-that-is-long-enough",
        nonce: "nonce-value-that-is-long-enough"
      }
    ));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" }
    });
  });

  it("accepts a valid agent bootstrap only through the installed application adapter", async () => {
    let received: unknown;
    installNodeEnrollmentAdapter({
      enrollAgent: async (input: Parameters<NodeEnrollmentApplicationAdapter["enrollAgent"]>[0]) => {
        received = input;
        return {
          nodeId: "node-1",
          credentialId: "credential-1",
          identityCertificate: "certificate",
          certificateChain: "chain",
          controlPlaneIdentity: {
            nodeId: "node-1",
            portfolioId: "portfolio-a",
            companyId: "company-a"
          },
          configuration: { protocolVersion: "1.0.0" },
          replay: false
        };
      }
    } as unknown as NodeEnrollmentApplicationAdapter);

    const response = await handleAgentNodeEnrollment(jsonRequest(
      "http://localhost/api/agent/v1/enroll",
      {
        enrollmentToken: "bootstrap-token-that-is-long-enough",
        agentVersion: "0.2.0",
        protocolVersion: "1.0.0",
        architecture: "arm64",
        bootstrapPublicKey: "public-key-material-that-is-long-enough",
        nonce: "nonce-value-that-is-long-enough"
      }
    ));
    expect(response.status).toBe(201);
    expect(received).toMatchObject({ architecture: "arm64" });
  });

  it("requires existing Control API authentication and idempotency for owner create", async () => {
    installOwnerAuth();
    let received: unknown;
    installNodeEnrollmentAdapter({
      create: async (
        _principal: ControlApiPrincipal,
        input: CreateNodeEnrollmentInput
      ) => {
        received = input;
        return {
          enrollmentId: input.id,
          challengeId: "challenge-1",
          enrollmentToken: "bootstrap-token",
          architecture: input.architecture,
          expiresAt: "2026-09-21T12:15:00Z"
        };
      }
    } as unknown as NodeEnrollmentApplicationAdapter);

    const missingKey = await handleCreateNodeEnrollment(jsonRequest(
      "http://localhost/api/control/nodes/enrollments",
      {
        id: "enrollment-1",
        displayName: "Server",
        architecture: "x86_64",
        ownerActionRequired: false
      }
    ));
    expect(missingKey.status).toBe(400);

    const response = await handleCreateNodeEnrollment(jsonRequest(
      "http://localhost/api/control/nodes/enrollments",
      {
        id: "enrollment-1",
        displayName: "Server",
        architecture: "x86_64",
        ownerActionRequired: false
      },
      "owner-enroll-1"
    ));
    expect(response.status).toBe(201);
    expect(received).toMatchObject({
      id: "enrollment-1",
      architecture: "x86_64",
      idempotencyKey: "owner-enroll-1"
    });
  });

  it("routes owner actions and rejects invalid action payloads", async () => {
    installOwnerAuth();
    let action = "";
    installNodeEnrollmentAdapter({
      ownerAction: async () => {
        action = "owner-action";
        return { state: "owner-action" };
      },
      cancel: async () => {
        action = "cancel";
        return { state: "cancelled" };
      },
      expire: async () => {
        action = "expire";
        return { state: "expired" };
      }
    } as unknown as NodeEnrollmentApplicationAdapter);

    const invalid = await handleNodeEnrollmentAction(
      jsonRequest(
        "http://localhost/api/control/nodes/enrollments/challenge-1/actions",
        { action: "owner-action" },
        "action-1"
      ),
      "challenge-1"
    );
    expect(invalid.status).toBe(400);

    const response = await handleNodeEnrollmentAction(
      jsonRequest(
        "http://localhost/api/control/nodes/enrollments/challenge-1/actions",
        { action: "owner-action", evidenceId: "evidence-1" },
        "action-2"
      ),
      "challenge-1"
    );
    expect(response.status).toBe(200);
    expect(action).toBe("owner-action");
  });

  it("returns not found for an absent scoped owner enrollment", async () => {
    installOwnerAuth();
    installNodeEnrollmentAdapter({
      get: async () => null
    } as unknown as NodeEnrollmentApplicationAdapter);

    const response = await handleGetNodeEnrollment(
      new Request("http://localhost/api/control/nodes/enrollments/missing"),
      "missing"
    );
    expect(response.status).toBe(404);
  });
});
