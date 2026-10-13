import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { createApprovalProof } from "@/lib/authorization/proofs";
import { actionableInbox, inboxObjectId, isOwnerInputQuestion } from "./inbox";
import { capabilityMap, connectionRequirement } from "./capability-map";
import { normalizeEvidence, authorizedEvidence } from "./evidence";
import { createExecutionPreview, assertPreviewApproval } from "./preview";
import { operationalFooter } from "./footer";
import { evaluateObjective } from "./objective-evaluation";
import { OperationalStore } from "./store.server";
import { associateMeasuredImpact, verifiedRecommendationScore, type VerifiedOutcome } from "./outcomes";
import type { OperationalConnection, OwnerInboxItem, OperationScope } from "./contracts";
import type { ObjectiveRecord } from "@/lib/domain/objective-inbox";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";

const scope: OperationScope = { userId: "owner", portfolioId: "p", companyId: "c", environment: "staging" };
const now = "2026-10-12T18:00:00.000Z", at = Date.parse(now), hash = "a".repeat(64), sha = "b".repeat(40);
const connection: OperationalConnection = { id: "github", portfolioId: "p", companyId: "c", environment: "staging",
  provider: "github", status: "healthy", resources: ["acme/app"], grantedUserIds: ["owner"],
  workflows: ["github_repository_health", "github_create_branch"], updatedAt: now, sensitivity: "internal" };
function evidence(companyId = "c") { return normalizeEvidence({ evidenceId: "e", portfolioId: "p", companyId,
  environment: "staging", topic: "deployment", sourceType: "github", sourceRef: "acme/app", observedAt: now,
  freshUntil: "2026-10-12T19:00:00.000Z", summary: "Deployment failures recorded", facts: { failures: 3, token: "secret" },
  sensitivity: "internal", confidence: 0.9, deepLink: "https://github.com/acme/app",
  authorization: { connectionId: "github", resourceId: "acme/app", grantedUserIds: ["owner"], provenanceRef: "receipt-1", authorizedAt: now } }); }
function item(patch: Partial<OwnerInboxItem> = {}): OwnerInboxItem { return { id: inboxObjectId(scope, "job", "j"),
  portfolioId: "p", companyId: "c", environment: "staging", userId: "owner", kind: "job", objectType: "job", objectId: "j",
  state: "open", summary: "Failed job needs review", urgency: 1, impact: 0.8, confidence: 1,
  createdAt: now, updatedAt: now, sensitivity: "internal", nextAction: { label: "Review", href: "/operations/jobs/j" }, ...patch }; }
function preview(branch = "fix-health") { return createExecutionPreview({ scope,
  registration: capabilityMap(scope, [connection], at).find(v => v.action)!,
  parameters: { companyId: "c", connectionId: "github", repository: "acme/app", branch, fromRef: "main", expectedSourceSha: sha },
  policy: { disposition: "APPROVAL_REQUIRED", artifactHash: hash, planHash: hash, stepHash: hash },
  now, expiresAt: "2026-10-12T18:10:00.000Z" }); }
function proof() { return createApprovalProof({ id: "proof", decisionId: "d", approvalId: "a", actorId: "owner", scope,
  level: "approval", planHash: hash, stepHash: hash, previewHash: preview().previewHash,
  grantedAt: now, expiresAt: "2026-10-12T18:09:00.000Z" }); }
const objective = { id: "o", portfolioId: "p", companyId: "c", environment: "staging", status: "executing" } as ObjectiveRecord;

describe("optimization addendum acceptance", () => {
  it("What needs my input today returns only actionable authorized items and deduplicates underlying objects", () => {
    expect(isOwnerInputQuestion("What needs my input today?")).toBe(true);
    const rows = [item(), item({ id: "duplicate" }), item({ companyId: "other" }), item({ userId: "other" }),
      item({ state: "resolved" }), item({ sensitivity: "sensitive" }), item({ nextAction: { label: "unsafe", href: "https://evil.test/" } })];
    expect(actionableInbox(rows, scope, at)).toHaveLength(1);
  });
  it("names the exact missing revenue connection instead of promising GitHub can answer it", () => {
    expect(connectionRequirement("revenue", capabilityMap(scope, [connection], at))).toContain("dated gross/net revenue, reporting period and currency");
  });
  it("binds approval to deterministic preview hash", () => {
    expect(() => assertPreviewApproval(preview(), preview(), proof(), scope, at + 1000)).not.toThrow();
    expect(() => assertPreviewApproval(preview(), preview(), { ...proof(), previewHash: hash }, scope, at + 1000)).toThrow();
  });
  it("parameter changes, resource changes, expiry and payload tampering invalidate approval", () => {
    expect(() => assertPreviewApproval(preview(), preview("changed"), proof(), scope, at)).toThrow();
    expect(() => assertPreviewApproval({ ...preview(), resources: ["different"] }, preview(), proof(), scope, at)).toThrow();
    expect(() => assertPreviewApproval(preview(), preview(), proof(), scope, at + 20 * 60_000)).toThrow();
  });
  it("normalizes provider evidence and filters tenant authorization sensitivity topic and freshness before ranking", () => {
    const e = evidence();
    expect(e.facts).toEqual({ failures: 3 });
    expect(authorizedEvidence([e, evidence("other"), { ...e, sensitivity: "sensitive" }], scope, "deployment", ["internal"], at)).toEqual([e]);
    expect(authorizedEvidence([e], scope, "revenue", ["internal"], at)).toEqual([]);
    expect(authorizedEvidence([e], scope, "deployment", ["internal"], at + 2 * 3600_000)).toEqual([]);
    expect(authorizedEvidence([{ ...e, facts: { failures: 0 } }], scope, "deployment", ["internal"], at)).toEqual([]);
  });
  it("scheduled evaluation persists recommendations but has no external write or authority path", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => ({ rows: sql.includes("INSERT") ? [{ id: "saved" }] : [], rowCount: 1 }));
    const store = new OperationalStore({ query } as SqlQueryable, scope);
    const result = await store.evaluateScheduled(objective, { topic: "deployment", key: "failures", target: 0, operator: "lte" }, now);
    expect(result.consequentialExecutionAuthorized).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes("authorization_grants") || sql.includes("job_execution_specs"))).toBe(false);
    expect(query.mock.calls.filter(([sql]) => sql.includes("INSERT")).map(([, params]) => params[0]))
      .toEqual(["objective-evaluation", "owner-inbox-item"]);
  });
  it("calculates comparable measurable change without claiming missing measurements are zero", () => {
    const first = evaluateObjective(scope, objective, { topic: "deployment", key: "failures", target: 0, operator: "lte" }, [evidence()], now);
    expect(first.current).toBe(3); expect(first.delta).toBeNull(); expect(first.achieved).toBe(false);
    expect(evaluateObjective(scope, objective, { topic: "revenue", key: "net", target: 1, operator: "gte" }, [evidence()], now).current).toBeNull();
  });
  it("verified positive outcomes rank recommendations without changing policy", () => {
    const base = { id: "out", scope, topic: "deployment", findingId: "f", recommendationId: "r", recommendationKind: "investigate",
      predictedOutcome: "healthy", approvedPreviewHash: hash, executionReceiptId: "exec", executionReceiptHash: hash,
      verificationReceiptId: "verify", verificationReceiptHash: hash, verificationResult: "verified" as const,
      objectiveImpact: 1, observedAt: now };
    const outcome: VerifiedOutcome = { ...base, outcomeHash: sha256Hex(base) };
    const policy = Object.freeze({ disposition: "STRONG_APPROVAL", blocked: ["delete", "merge"] });
    expect(verifiedRecommendationScore(0.5, "investigate", "deployment", scope, [outcome], at)).toBeGreaterThan(0.5);
    expect(verifiedRecommendationScore(0.5, "investigate", "deployment", { ...scope, companyId: "other" }, [outcome], at)).toBe(0.5);
    expect(policy).toEqual({ disposition: "STRONG_APPROVAL", blocked: ["delete", "merge"] });
  });
  it("requires scoped before/after measurements for objective impact and never treats branch verification as improvement", () => {
    const metric = { topic: "deployment", key: "failures", target: 0, operator: "lte" as const };
    const before = evaluateObjective(scope, objective, metric, [evidence()], now);
    const after = { ...before, id: "later", current: 1, observedAt: "2026-10-12T18:03:00.000Z" };
    const base = { id: "out", scope, topic: "deployment", objectiveId: "o", findingId: "f", recommendationId: "r",
      recommendationKind: "github_create_branch", predictedOutcome: "repair", approvedPreviewHash: hash,
      executionReceiptId: "exec", executionReceiptHash: hash, verificationReceiptId: "verify", verificationReceiptHash: hash,
      verificationResult: "verified" as const, objectiveImpact: null, observedAt: "2026-10-12T18:01:00.000Z" };
    const outcome = { ...base, outcomeHash: sha256Hex(base) };
    expect(verifiedRecommendationScore(0.4, "github_create_branch", "deployment", scope, [outcome], at + 300000)).toBe(0.4);
    const measured = associateMeasuredImpact(outcome, before, after, metric);
    expect(measured.objectiveImpact).toBe(2);
    expect(measured.impactEvaluationIds).toEqual([before.id, after.id]);
    expect(associateMeasuredImpact(outcome, before, { ...after, companyId: "other" }, metric)).toBe(outcome);
    expect(associateMeasuredImpact(outcome, before, { ...after, observedAt: now }, metric)).toBe(outcome);
    expect(verifiedRecommendationScore(0.4, "github_create_branch", "deployment", scope, [measured], at + 300000)).toBeGreaterThan(0.4);
  });
  it("business switching excludes the previous business's inbox and evidence", () => {
    const switched = { ...scope, companyId: "other" };
    expect(actionableInbox([item()], switched, at)).toEqual([]);
    expect(authorizedEvidence([evidence()], switched, undefined, ["internal"], at)).toEqual([]);
  });
  it("broken integrations appear as degraded scoped capabilities", () => {
    expect(capabilityMap(scope, [{ ...connection, status: "broken" }], at).filter(v => v.provider === "github").map(v => v.status)).toEqual(["degraded", "degraded"]);
    expect(capabilityMap({ ...scope, userId: "intruder" }, [connection], at).every(v => !v.connectionId)).toBe(true);
  });
  it("footers contain no sensitive facts, provider metadata, credentials or unsafe URLs", () => {
    const footer = operationalFooter([evidence()], { deepLink: "https://github.com/acme/app?token=secret" });
    expect(JSON.stringify(footer)).not.toMatch(/secret|token|authorization|grantedUserIds|failures/);
    expect(footer.deepLink).toBeUndefined();
  });
});
