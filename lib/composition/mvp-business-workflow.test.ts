import { describe, expect, it } from "vitest";
import {
  MvpBusinessWorkflow,
  type ProposedBusinessAction
} from "@/lib/composition/mvp-business-workflow";
import type { JobRecord } from "@/lib/domain/services/job-service";

const scope = {
  userId: "owner",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "production" as const
};

const budget = {
  portfolioId: "portfolio-a",
  companyId: "company-a",
  period: "2026-09",
  companyRemainingCents: 100,
  portfolioRemainingCents: 100,
  activeConcurrentCalls: 0,
  concurrencyLimit: 4,
  snapshotAt: "2026-09-22T11:59:00Z",
  expiresAt: "2026-09-22T12:10:00Z"
};

describe("MVP business workflow is proposal-only", () => {
  it("keeps AI proposal-only and rejects the retired parallel execution entrypoint", async () => {
    const ai = {
      invoke: async () => ({
        kind: "success" as const,
        output: {
          summary: "Sync the at-risk account",
          reason: "The renewal signal crossed the configured threshold",
          operation: "crm.contact.sync",
          payload: { contactId: "contact-1" }
        },
        route: {} as never,
        audit: { auditHash: "ai-audit-hash" } as never
      })
    };
    const workflow = new MvpBusinessWorkflow(
      ai,
      { ownerView: async () => ({ status: "succeeded" }) },
      () => new Date("2026-09-22T12:00:00Z")
    );
    const proposal = await workflow.propose({
      detection: {
        id: "detection-1",
        signalType: "renewal-risk",
        payload: { contactId: "contact-1" },
        observedAt: "2026-09-22T11:59:00Z"
      },
      scope,
      budget
    });
    expect(proposal.authorityApplied).toBe(false);

    expect(() => workflow.enqueueAfterAuthoritativeDecision({
      proposal,
      job: { id: "job-1" } as JobRecord,
      request: {} as never
    })).toThrow(/authoritative orchestration path/i);
  });

  it("still detects tampered proposals before rejecting legacy execution", () => {
    const workflow = new MvpBusinessWorkflow(
      { invoke: async () => { throw new Error("unused"); } },
      { ownerView: async () => undefined }
    );
    const proposal = {
      id: "proposal-1",
      detectionId: "detection-1",
      scope,
      summary: "x",
      reason: "x",
      capability: "http.request" as const,
      input: { companyId: "company-a", operation: "crm.contact.sync", payload: {} },
      aiAuditHash: "audit",
      authorityApplied: false as const,
      proposedAt: "2026-09-22T12:00:00Z",
      proposalHash: "tampered"
    } satisfies ProposedBusinessAction;
    expect(() => workflow.enqueueAfterAuthoritativeDecision({
      proposal,
      job: { id: "job-1" } as JobRecord,
      request: {} as never
    })).toThrow(/integrity/i);
  });
});
