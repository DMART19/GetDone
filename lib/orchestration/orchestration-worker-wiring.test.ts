import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthoritativeExecutionCoordinator } from "./authoritative-execution-coordinator";
import type { PlannerAIBudgetProvider } from "./ai-gateway-planner";
import { createAuthoritativeExecutionCoordinatorFromEnv } from "./orchestration-worker-runtime.server";
import { executionFixture } from "./test-fixture";
const database = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("@/lib/persistence/postgres/runtime.server", () => ({ getPostgresRuntimeFromEnv: () => ({ database }) }));
vi.mock("@/lib/ai-gateway/runtime.server", () => ({ getAIGatewayFromEnv: () => ({}) }));
vi.mock("./authoritative-execution-coordinator", () => ({ AuthoritativeExecutionCoordinator: class { constructor(readonly dependencies: unknown) {} } }));
vi.mock("./ai-gateway-planner", () => ({ AIGatewayDurablePlanner: class { constructor(readonly gateway: unknown, readonly budget: unknown) {} } }));
type Dependencies = ConstructorParameters<typeof AuthoritativeExecutionCoordinator>[0];
async function fixture() {
  const built = await executionFixture();
  const coordinator = createAuthoritativeExecutionCoordinatorFromEnv({}, built.now) as unknown as { dependencies: Dependencies };
  return { ...built, deps: coordinator.dependencies };
}
beforeEach(() => { database.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 }); database.transaction.mockReset(); });
describe("authoritative worker dependency wiring", () => {
  it("assembles owner and objective context from scoped authoritative rows", async () => {
    const { deps, run, now } = await fixture();
    database.query.mockResolvedValue({ rows: ["decision", "outcome", "verification", "resource", "objective", "job"].map(entity_type => ({ entity_type, id: entity_type + "-1", updated_at: now().toISOString(), payload: { name: entity_type } })) });
    const candidates = await deps.objectiveContext!.candidates.listForObjective({ run, objective: {} as never });
    expect(candidates.map(c => c.kind)).toEqual(["decision", "outcome", "outcome", "resource-summary", "fact", "fact"]);
    expect(candidates.every(c => c.companyId === run.scope.companyId && c.portfolioId === run.scope.portfolioId)).toBe(true);
    expect(candidates[3].resourceId).toBe("resource-1");
    expect(database.query.mock.calls[0][1].slice(0, 2)).toEqual([run.scope.portfolioId, run.scope.companyId]);
    expect(database.query.mock.calls[0][0]).toContain("LIMIT 40");
    expect(await deps.ownerIntentContext.candidates.listForIntent({ run, intent: {} as never })).toEqual(candidates);
    const policy = await deps.objectiveContext!.policy.resolve({ run: { ...run, scope: { ...run.scope, resourceId: "resource-1" } }, objective: {} as never });
    expect(policy.scope).toMatchObject({ portfolioId: run.scope.portfolioId, companyId: run.scope.companyId, allowedResourceIds: ["resource-1"] });
    expect((await deps.ownerIntentContext.policy.resolve({ run, intent: {} as never })).scope.allowedResourceIds).toBeUndefined();
  });
  it("computes bounded daily AI budgets from scoped persisted spend", async () => {
    const { deps, run, now } = await fixture();
    const { budget } = deps.planner.planner as unknown as { budget: PlannerAIBudgetProvider };
    database.query.mockResolvedValueOnce({ rows: [{ cents: "123" }] }).mockResolvedValueOnce({ rows: [{ cents: 50_000 }] });
    const snapshot = await budget.snapshot({ plannerInput: { scope: run.scope } as never, requestId: "request-1" });
    expect(snapshot).toMatchObject({ companyRemainingCents: 4877, portfolioRemainingCents: 0, concurrencyLimit: 2 });
    expect(snapshot.expiresAt).toBe(new Date(now().getTime() + 60_000).toISOString());
    expect(database.query.mock.calls[0][1]).toEqual([run.scope.portfolioId, run.scope.companyId, now().toISOString().slice(0, 10) + "T00:00:00.000Z"]);
    database.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    expect(await budget.snapshot({ plannerInput: { scope: run.scope } as never, requestId: "request-2" })).toMatchObject({ companyRemainingCents: 5000, portfolioRemainingCents: 20000 });
    database.query.mockResolvedValueOnce({ rows: [{ cents: "not-a-number" }] }).mockResolvedValueOnce({ rows: [] });
    await expect(budget.snapshot({ plannerInput: { scope: run.scope } as never, requestId: "request-3" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it("uses exact tenant validation limits and requires credentials only where requested", async () => {
    const { deps, run, plan } = await fixture();
    const result = await deps.validation.resolver.resolve({ run, idempotencyKey: "validation-1", planArtifact: plan });
    expect(result.validationPolicy).toMatchObject({ trustedScope: { portfolioId: run.scope.portfolioId, companyId: run.scope.companyId }, allowedEnvironments: [run.scope.environment], maxPlanCostCents: 10000, availableCredentialBindings: true });
    expect(result.snapshot.evidenceRequirements.credentials).toBe("not-applicable");
    const proposal = { ...plan.proposal, steps: plan.proposal.steps.map(step => ({ ...step, resourceRequirements: { ...step.resourceRequirements, credentialBindingRequired: true } })) };
    const missing = await deps.validation.resolver.resolve({ run, idempotencyKey: "validation-1", planArtifact: { ...plan, proposal } });
    expect(missing.validationPolicy.availableCredentialBindings).toBe(false);
    expect(missing.snapshot.evidenceRequirements.credentials).toBe("required");
    expect(missing.snapshot.credentialReference).toMatchObject({ hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    database.query.mockResolvedValue({ rows: [{ payload: { id: "integration", companyId: run.scope.companyId, portfolioId: run.scope.portfolioId, environment: run.scope.environment, connectionStatus: "connected", health: "healthy", credentialBinding: "binding-1", supportedCapabilities: ["repository.inspect"] } }] });
    const present = await deps.validation.resolver.resolve({ run, idempotencyKey: "validation-1", planArtifact: { ...plan, proposal } });
    expect(present.validationPolicy.availableCredentialBindings).toBe(true);
  });
  it("loads authoritative kill switches and preserves region and fallback restrictions", async () => {
    const { deps, run, plan } = await fixture();
    const kill = { id: "kill-1", scopeType: "company", scopeId: run.scope.companyId, enabled: true, reason: "Owner pause", activatedAt: plan.createdAt, activatedBy: run.scope.userId };
    database.query.mockResolvedValue({ rows: [{ payload: kill }] });
    const step = plan.proposal.steps[0];
    const result = await deps.policy.resolver.resolveStep({ run, planArtifact: plan, step, validationArtifact: {} as never, idempotencyKey: "policy-1" });
    expect(result.killSwitches).toEqual([kill]);
    expect(result.objectiveId).toBe(run.source.id);
    expect(result.credentialRequirementIds).toEqual([]);
    const constrained = { ...step, resourceRequirements: { ...step.resourceRequirements, data: { ...step.resourceRequirements.data, allowedRegions: ["eu"] }, reliability: { ...step.resourceRequirements.reliability, fallbackRequired: true } } };
    expect(await deps.policy.resolver.resolveStep({ run, planArtifact: plan, step: constrained, validationArtifact: {} as never, idempotencyKey: "policy-1" })).toMatchObject({ region: "eu", allowedRegions: ["eu"], fallbackRequired: true, fallbackAvailable: false });
  });
  it.each([null, [], {}, { id: "kill", scopeType: "unknown" }, { id: "kill", scopeType: "global", scopeId: "all", enabled: true, reason: "pause", activatedAt: "invalid", activatedBy: "owner" }])("fails closed on malformed kill-switch authority %j", async payload => {
    const { deps, run, plan } = await fixture();
    database.query.mockResolvedValue({ rows: [{ payload }] });
    await expect(deps.policy.resolver.resolveStep({ run, planArtifact: plan, step: plan.proposal.steps[0], validationArtifact: {} as never, idempotencyKey: "policy-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
