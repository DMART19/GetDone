import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { OperationalStore } from "@/lib/operations/store.server";
import type { NormalizedEvidence, OperationalConnection, OwnerInboxItem } from "@/lib/operations/contracts";

const scope = Object.freeze({
  userId: "owner-one", portfolioId: "portfolio-one", companyId: "company-one", environment: "staging" as const
});
const now = "2026-11-20T18:00:00.000Z";

class FixtureDb {
  calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  payloads = new Map<string, unknown[]>();
  entityRows: unknown[] = [];
  conversationRows: unknown[] = [];
  executionRows: unknown[] = [];
  planRows: unknown[] = [];
  inserted: Array<{ type: string; payload: unknown }> = [];
  allowWrite = true;

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string, values?: readonly unknown[]
  ): Promise<QueryResult<R>> {
    this.calls.push({ text, values });
    let rows: unknown[] = [];
    let rowCount = 0;
    if (text.includes("INSERT INTO control_plane_entities")) {
      if (this.allowWrite) {
        this.inserted.push({ type: String(values?.[0]), payload: JSON.parse(String(values?.[5])) });
        rowCount = 1;
        rows = [{ id: values?.[1] }];
      }
    } else if (text.includes("SELECT DISTINCT ON (payload->>'threadId')")) {
      rows = this.conversationRows;
    } else if (text.includes("COALESCE(payload->>'title'")) {
      rows = this.entityRows;
    } else if (text.includes("FROM control_plane_entities j JOIN verification_receipts")) {
      rows = this.executionRows;
    } else if (text.includes("SELECT payload FROM orchestration_plan_proposals")) {
      rows = this.planRows;
    } else if (text.includes("SELECT payload FROM control_plane_entities")) {
      rows = (this.payloads.get(String(values?.[0])) ?? []).map(payload => ({ payload }));
    }
    return { command: "", rowCount, oid: 0, fields: [], rows } as unknown as QueryResult<R>;
  }
}

function connection(overrides: Partial<OperationalConnection> = {}): OperationalConnection {
  return {
    id: "github-one", portfolioId: scope.portfolioId, companyId: scope.companyId,
    environment: scope.environment, provider: "github", status: "healthy",
    resources: ["repo-one"], grantedUserIds: [scope.userId],
    workflows: ["github_repository_health"], updatedAt: now, sensitivity: "internal",
    ...overrides
  };
}

function inbox(overrides: Partial<OwnerInboxItem> = {}): OwnerInboxItem {
  return {
    id: "alert-one", portfolioId: scope.portfolioId, companyId: scope.companyId,
    environment: scope.environment, userId: scope.userId, objectType: "job",
    objectId: "job-one", kind: "job", state: "open", summary: "Review work",
    urgency: 0.8, impact: 0.7, confidence: 0.9, createdAt: now, updatedAt: now,
    sensitivity: "internal", nextAction: { label: "Review", href: "/operations/jobs/job-one" },
    ...overrides
  };
}

function evidence(overrides: Partial<NormalizedEvidence> = {}): NormalizedEvidence {
  const base = {
    evidenceId: "proof-one", portfolioId: scope.portfolioId, companyId: scope.companyId,
    environment: scope.environment, topic: "deployments", sourceType: "github",
    sourceRef: "repo-one", observedAt: now, freshUntil: "2026-11-21T18:00:00.000Z",
    sensitivity: "internal" as const, summary: "Verified status", facts: { healthy: true },
    confidence: 0.9, authorization: {
      connectionId: "github-one", resourceId: "repo-one", grantedUserIds: [scope.userId],
      provenanceRef: "receipt-one", authorizedAt: now
    }
  };
  return { ...base, contentHash: sha256Hex(base), ...overrides };
}

describe("scoped operational persistence", () => {
  it("lists only scoped entity types and omits malformed connection/evidence rows", async () => {
    const db = new FixtureDb();
    db.payloads.set("operational-connection", [connection(), { status: "bogus" }]);
    db.payloads.set("normalized-evidence", [evidence(), { evidenceId: "" }]);
    const store = new OperationalStore(db, scope);
    expect((await store.connections()).map(x => x.id)).toEqual(["github-one"]);
    expect((await store.evidence()).map(x => x.evidenceId)).toEqual(["proof-one"]);
    expect(db.calls[0].values).toEqual(["operational-connection", scope.portfolioId, scope.companyId, "staging"]);
  });

  it("surfaces actionable owner inbox items but not other-owner or resolved records", async () => {
    const db = new FixtureDb();
    db.payloads.set("owner-inbox-item", [
      inbox(), inbox({ id: "other", userId: "someone-else" }),
      inbox({ id: "resolved", state: "resolved" }),
      inbox({ id: "future", createdAt: "2027-01-01T00:00:00.000Z" })
    ]);
    const items = await new OperationalStore(db, scope).inbox(Date.parse(now) + 1000);
    expect(items).toHaveLength(1);
    expect(items[0].summary).toBe("Review work");
  });

  it("rejects cross-tenant and cross-environment writes before any query", async () => {
    const db = new FixtureDb();
    const store = new OperationalStore(db, scope);
    for (const changed of [
      { portfolioId: "another" }, { companyId: "another" }, { environment: "production" }
    ]) {
      await expect(store.put("operational-connection", "connection", {
        ...scope, ...changed
      }, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(db.calls).toHaveLength(0);
  });

  it("hashes storage ids and refuses cross-scope upsert conflicts", async () => {
    const db = new FixtureDb();
    const store = new OperationalStore(db, scope);
    await store.put("operational-connection", "connection", scope, now);
    expect(db.inserted).toHaveLength(1);
    expect(db.calls[0].values?.[1]).toMatch(/^operational-connection:[a-f0-9]{64}$/);
    db.allowWrite = false;
    await expect(store.put("operational-connection", "connection", scope, now))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("preserves original inbox creation time across updates", async () => {
    const db = new FixtureDb();
    db.payloads.set("owner-inbox-item", [inbox({ createdAt: "2026-10-01T18:00:00.000Z" })]);
    await new OperationalStore(db, scope).saveInbox(inbox({ summary: "Changed" }));
    expect(db.inserted[0].payload).toMatchObject({
      createdAt: "2026-10-01T18:00:00.000Z", summary: "Changed"
    });
  });

  it("rejects inbox records belonging to a different owner", async () => {
    const db = new FixtureDb();
    await expect(new OperationalStore(db, scope).saveInbox(
      inbox({ userId: "someone-else" })
    )).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.calls).toHaveLength(0);
  });

  it("requires valid evidence integrity and an explicit owner grant", async () => {
    const db = new FixtureDb();
    const store = new OperationalStore(db, scope);
    await expect(store.saveEvidence(evidence({ contentHash: "a".repeat(64) })))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    const withoutGrant = evidence({
      authorization: {
        ...evidence().authorization, grantedUserIds: ["someone-else"]
      }
    });
    await expect(store.saveEvidence(withoutGrant))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await store.saveEvidence(evidence());
    expect(db.inserted[0].type).toBe("normalized-evidence");
  });

  it("refreshes approvals, failed jobs, owner-input objectives, connections and conversations", async () => {
    const db = new FixtureDb();
    db.entityRows = [
      { id: "decision/1", entity_type: "decision", title: "Approval", state: "pending", updated_at: now },
      { id: "job/1", entity_type: "job", title: "Deploy", state: "failed", updated_at: now },
      { id: "objective/1", entity_type: "objective", title: "Goal", state: "needs_owner_input", updated_at: now },
      { id: "objective/2", entity_type: "objective", title: "Not done", state: "in_progress", updated_at: now },
      { id: "objective/3", entity_type: "objective", title: "Done", state: "completed", updated_at: now }
    ];
    db.payloads.set("operational-connection", [
      connection({ id: "broken", status: "broken" }),
      connection({ id: "expired", expiresAt: "2026-11-21T18:00:00.000Z" }),
      connection({ id: "different", grantedUserIds: ["someone-else"] })
    ]);
    db.conversationRows = [
      { id: "turn-1", payload: { threadId: "thread-1", conversationState: { question: "Which repo?" } } },
      { id: "turn-2", payload: {} }
    ];
    await new OperationalStore(db, scope).refreshInbox(now);
    const items = db.inserted.map(({ payload }) => payload as OwnerInboxItem);
    expect(items).toHaveLength(8);
    expect(items.some(x => x.kind === "approval" && x.state === "open" && x.nextAction.href === "/decisions/decision%2F1")).toBe(true);
    expect(items.some(x => x.kind === "job" && x.urgency === 1)).toBe(true);
    expect(items.some(x => x.kind === "owner-input" && x.state === "open")).toBe(true);
    expect(items.some(x => x.objectId === "objective/2")).toBe(false);
    expect(items.some(x => x.kind === "connection" && x.state === "open")).toBe(true);
    expect(items.some(x => x.kind === "ambiguity" && x.state === "resolved")).toBe(true);
  });

  it("skips verified outcome creation without matched execution receipts", async () => {
    const db = new FixtureDb();
    db.executionRows = [
      { job: { id: "job-1" }, decision: {}, receipt: {}, execution: {} },
      { job: { id: "job-2" }, decision: { executionPreview: { scope: { userId: "other" } } }, receipt: {}, execution: {} }
    ];
    await new OperationalStore(db, scope).captureVerifiedOutcomes(now);
    expect(db.inserted).toHaveLength(0);
  });

  it("evaluates a scoped objective from read-only evidence without authorizing execution", async () => {
    const db = new FixtureDb();
    const store = new OperationalStore(db, scope);
    const objective = {
      id: "objective-one", ...scope, createdByUserId: scope.userId,
      status: "blocked", dependsOnObjectiveIds: [], successCriteria: []
    };
    const result = await store.evaluateScheduled(
      objective as never,
      { topic: "deployments", key: "successful", target: 2, operator: "gte" },
      now
    );
    expect(result).toMatchObject({
      objectiveId: "objective-one", current: null,
      ownerInputRequired: true, consequentialExecutionAuthorized: false
    });
    expect(db.inserted.map(x => x.type)).toEqual([
      "objective-evaluation", "owner-inbox-item"
    ]);
  });
});

describe("verified operational outcomes", () => {
  it("links cryptographically verified provider work to an owner-reviewed continuation, never automatic authority", async () => {
    const db = new FixtureDb();
    const receiptBase = {
      id: "receipt-one", verdict: "verified", subject: { id: "job-one" },
      verifiedAt: now
    };
    const receiptHash = sha256Hex(receiptBase);
    const executionBase = { requestId: "request-one", state: "completed" };
    const recordHash = sha256Hex(executionBase);
    const planHash = "p".repeat(64);
    db.executionRows = [{
      job: { id: "job-one", verificationReceiptHash: receiptHash },
      decision: {
        executionPreview: {
          scope: { userId: scope.userId }, planHash,
          workflow: "github_create_branch", previewHash: "v".repeat(64)
        },
        approvalBinding: { planArtifactId: "plan-one", stepId: "step-one" }
      },
      receipt: { ...receiptBase, receiptHash },
      execution: { ...executionBase, recordHash }
    }];
    db.planRows = [{
      payload: {
        planHash,
        proposal: {
          source: { type: "objective", objectiveId: "objective-one" },
          steps: [{ id: "step-one", evidenceIds: ["evidence-one"], expectedOutcome: "branch exists" }]
        }
      }
    }];
    db.payloads.set("objective", [{
      id: "objective-one", ...scope, createdByUserId: scope.userId,
      status: "failed", dependsOnObjectiveIds: [], successCriteria: []
    }]);
    const store = new OperationalStore(db, scope);
    await store.captureVerifiedOutcomes(now);
    const types = db.inserted.map(x => x.type);
    expect(types).toEqual([
      "verified-outcome", "objective-continuation-proposal", "owner-inbox-item"
    ]);
    const outcome = db.inserted[0].payload as { outcomeHash: string; objectiveImpact: unknown; jobId: string };
    expect(outcome.jobId).toBe("job-one");
    expect(outcome.objectiveImpact).toBeNull();
    expect(outcome.outcomeHash).toMatch(/^[a-f0-9]{64}$/);
    const continuation = db.inserted[1].payload as { consequentialExecutionAuthorized: boolean; requiresAdmission: boolean };
    expect(continuation.requiresAdmission).toBe(true);
    expect(continuation.consequentialExecutionAuthorized).toBe(false);
  });

  it("does not convert an invalid receipt or unmatched plan into verified business impact", async () => {
    const db = new FixtureDb();
    db.executionRows = [{
      job: { id: "job-one", verificationReceiptHash: "fake" },
      decision: { executionPreview: { scope: { userId: scope.userId } } },
      receipt: { verdict: "verified", subject: { id: "job-one" }, receiptHash: "wrong" },
      execution: { recordHash: "wrong" }
    }];
    await new OperationalStore(db, scope).captureVerifiedOutcomes(now);
    expect(db.inserted).toHaveLength(0);
  });
});
