import { describe, expect, it } from "vitest";
import type { ControlApiPrincipal } from "@/lib/control-api/contracts";
import type { AuthoritativeDecision } from "@/lib/domain/decision-service";
import {
  acceptanceGrant,
  assembleAcceptanceResult,
  assertStagingBrowserAcceptanceRequest
} from "@/lib/staging/browser-acceptance.server";

const env = {
  GETDONE_RUNTIME_ENV: "staging",
  GETDONE_STAGING_BROWSER_E2E: "true",
  GETDONE_STAGING_ACCEPTANCE_TOKEN: "fixture-token"
};

const principal: ControlApiPrincipal = {
  actor: { type: "user", id: "owner-a" },
  scope: {
    userId: "owner-a",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging"
  },
  sessionId: "session-a",
  role: "owner"
};

const decision: AuthoritativeDecision = {
  id: "decision-a",
  correlationId: "corr-a",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  status: "approved",
  version: 2,
  requiresStepUp: false,
  updatedAt: "2026-09-24T12:00:00.000Z"
};

describe("staging browser acceptance authority", () => {
  it("requires both staging mode and a constant-time acceptance token", () => {
    const request = new Request("http://localhost/staging", {
      headers: { "x-getdone-staging-acceptance-token": "fixture-token" }
    });
    expect(() => assertStagingBrowserAcceptanceRequest(request, env)).not.toThrow();

    expect(() => assertStagingBrowserAcceptanceRequest(
      new Request("http://localhost/staging"),
      env
    )).toThrow(/token is required/i);

    expect(() => assertStagingBrowserAcceptanceRequest(request, {
      ...env,
      GETDONE_RUNTIME_ENV: "production"
    })).toThrow(/unavailable/i);

    expect(() => assertStagingBrowserAcceptanceRequest(request, {
      ...env,
      GETDONE_STAGING_BROWSER_E2E: "false"
    })).toThrow(/unavailable/i);
  });

  it("creates a scoped short-lived authorization grant bound to the approved decision", () => {
    const grant = acceptanceGrant(
      principal,
      decision,
      "corr-a",
      new Date("2026-09-24T12:00:00.000Z")
    );
    expect(grant).toMatchObject({
      id: "staging-grant:corr-a",
      status: "active",
      disposition: "APPROVAL_REQUIRED",
      decisionId: "decision-a",
      scope: principal.scope,
      capabilityNames: ["http.request"],
      issuedAt: "2026-09-24T12:00:00.000Z",
      expiresAt: "2026-09-24T12:15:00.000Z"
    });
    expect(grant.grantHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires matching durable/provider/verification correlation before declaring completion", () => {
    const complete = assembleAcceptanceResult({
      job: {
        correlationId: "corr-a",
        taskId: "task-a",
        state: "queued"
      },
      jobId: "job-a",
      runtimeRow: {
        runtime_state: "released",
        envelope: { correlationId: "corr-a" }
      },
      providerRow: {
        state: "completed",
        provider_operation_id: "provider-a",
        payload: { correlationId: "corr-a" }
      },
      evidenceRow: {
        evidence_id: "evidence-a",
        payload: { correlationId: "corr-a", result: "pass" }
      },
      outcomeRow: {
        kind: "succeeded",
        payload: { correlationId: "corr-a" }
      }
    });
    expect(complete).toEqual({
      correlationId: "corr-a",
      decisionId: "browser-decision:corr-a",
      taskId: "task-a",
      jobId: "job-a",
      controlPlaneJobState: "queued",
      runtimeState: "released",
      providerState: "completed",
      providerOperationId: "provider-a",
      verificationEvidenceId: "evidence-a",
      verificationResult: "pass",
      durableOutcome: "succeeded",
      authoritativeCompletion: true
    });

    expect(assembleAcceptanceResult({
      job: {
        correlationId: "corr-a",
        taskId: "task-a",
        state: "queued"
      },
      jobId: "job-a",
      runtimeRow: {
        runtime_state: "released",
        envelope: { correlationId: "corr-a" }
      },
      providerRow: {
        state: "completed",
        provider_operation_id: "provider-a",
        payload: { correlationId: "wrong" }
      },
      evidenceRow: {
        evidence_id: "evidence-a",
        payload: { correlationId: "corr-a", result: "pass" }
      },
      outcomeRow: {
        kind: "succeeded",
        payload: { correlationId: "corr-a" }
      }
    }).authoritativeCompletion).toBe(false);

    expect(assembleAcceptanceResult({
      job: { taskId: "task-a", state: "queued" },
      jobId: "job-a"
    })).toMatchObject({
      correlationId: "",
      runtimeState: null,
      providerState: null,
      verificationResult: null,
      durableOutcome: null,
      authoritativeCompletion: false
    });
  });
});
