import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
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

describe("real MVP business workflow composition", () => {
  it("keeps AI proposal-only, then requires authoritative lineage before dispatch", async () => {
    const enqueued: unknown[] = [];
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
    const runtime = {
      enqueueAuthorizedHttpAction: async (job: JobRecord) => { enqueued.push(job); return { status: "enqueued" }; },
      ownerView: async () => ({ status: "succeeded" })
    };
    const workflow = new MvpBusinessWorkflow(ai, runtime, () => new Date("2026-09-22T12:00:00Z"));
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
    expect(enqueued).toHaveLength(0);

    const consumption = {
      id: "consumption-1",
      grantId: "grant-1",
      grantHash: "grant-hash",
      consumerType: "task" as const,
      consumerId: "task-1",
      scope,
      planHash: "plan-hash",
      stepHash: "step-hash",
      consumedAt: "2026-09-22T12:00:00Z",
      consumptionHash: "consumption-hash"
    };
    const job: JobRecord = {
      id: "job-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      state: "queued",
      taskId: "task-1",
      attempt: 0,
      authorizationGrantId: "grant-1",
      authorizationGrantHash: "grant-hash",
      authorizationConsumption: consumption,
      verificationEvidenceIds: [],
      version: 2,
      updatedAt: "2026-09-22T12:00:00Z"
    };
    const request = {
      id: "action-1",
      jobId: "job-1",
      scope,
      capability: "http.request",
      input: proposal.input,
      inputHash: sha256Hex(proposal.input),
      authorizationConsumptionHash: consumption.consumptionHash,
      credentialLeaseId: "lease-1",
      idempotencyKey: "action-key",
      timeoutMs: 5_000,
      attempt: 1
    };
    await workflow.enqueueAfterAuthoritativeDecision({ proposal, job, request });
    expect(enqueued).toHaveLength(1);
  });

  it("rejects tampered proposals and Jobs without authoritative grants", async () => {
    const workflow = new MvpBusinessWorkflow({ invoke: async () => { throw new Error("unused"); } }, {
      enqueueAuthorizedHttpAction: async () => undefined,
      ownerView: async () => undefined
    });
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
      job: { state: "queued" } as JobRecord,
      request: {} as never
    })).toThrow(/integrity/i);
  });
});
