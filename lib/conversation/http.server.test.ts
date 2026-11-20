import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnerIntentRecord } from "@/lib/control-api/contracts";
import { emptyState } from "./understanding";
import { getPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";
const fixture = vi.hoisted(() => ({
  records: [] as OwnerIntentRecord[], owner: true, locked: true,
  authenticate: vi.fn(), submit: vi.fn(), semantic: vi.fn(), query: vi.fn(),
  authDb: { query: vi.fn() }, catalogConnection: vi.fn()
}));
vi.mock("@/lib/businesses/runtime.server", () => ({ businessSession: async () => ({
  session: { userId: "owner" }, db: { query: fixture.query, transaction: async (operation: (client: unknown) => unknown) => operation({ query: async () => ({ rows: [{ locked: fixture.locked }] }) }) }
}) }));
vi.mock("@/lib/businesses/repository", () => ({
  listBusinesses: async (db: unknown) => {
    fixture.catalogConnection(db);
    if (db !== fixture.authDb) throw new Error("Catalog must use restricted pre-tenant auth role");
    return [{ id: "c", portfolioId: "p", name: "Acme" }];
  }
}));
vi.mock("@/lib/persistence/postgres/auth-runtime.server", () => ({
  getAuthPostgresDatabaseFromEnv: () => fixture.authDb
}));
vi.mock("@/lib/control-api/runtime.server", () => ({ getControlApiAdapter: () => ({
  authenticate: fixture.authenticate, submitOwnerIntent: fixture.submit,
  getOwnerIntentStatus: async (_principal: unknown, id: string) => { const r = fixture.records.find(r => r.id === id)!; return { intentId: id, conversation: r.conversation,
    answer: r.answer, lifecycle: { state: "answer", label: "Answered", terminal: true, verified: false } }; }
}) }));
vi.mock("@/lib/persistence/postgres/control-api-stores", () => ({ PostgresOwnerIntentStore: class {
  async listConversation(p: string, c: string, user: string, environment: string, thread?: string) {
    expect(getPostgresTenantScope()).toEqual({ portfolioId: p, companyId: c });
    return fixture.records.filter(r => r.portfolioId === p && r.companyId === c && r.userId === user && r.environment === environment && (!thread || r.threadId === thread));
  }
} }));
vi.mock("./semantic.server", () => ({ semanticInterpretation: fixture.semantic }));
vi.mock("@/lib/security/rate-limit.server", () => ({ RATE_LIMIT_POLICIES: { ownerIntent: {} }, enforceRateLimit: async () => {}, tenantRateLimitKey: () => [], rateLimitHeaders: () => ({}) }));
vi.mock("@/lib/control-plane/runtime-environment.server", () => ({ readServerRuntimeEnvironment: () => "staging" }));
import { handleThread } from "./http.server";
const threadId = "00000000-0000-4000-8000-000000000001";
const request = (body: unknown) => new Request("https://test/api/control/chat", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "key" }, body: JSON.stringify(body) });
beforeEach(() => {
  fixture.records = []; fixture.owner = true; fixture.locked = true; vi.clearAllMocks();
  fixture.semantic.mockResolvedValue(null);
  fixture.query.mockResolvedValue({ rows: [] });
  fixture.authenticate.mockImplementation(async () => ({ scope: { portfolioId: "p", companyId: "c", userId: "owner", environment: "staging" }, role: fixture.owner ? "owner" : "viewer" }));
  fixture.submit.mockImplementation(async (_principal, input, _key, _correlation, prepared) => {
    const record: OwnerIntentRecord = { id: "saved", portfolioId: "p", companyId: "c", userId: "owner", environment: "staging", message: input.message,
      channel: "chat", status: "answered", receivedAt: "2026-10-11T20:00:00Z", threadId: prepared.threadId, requestKeyHash: prepared.requestKeyHash,
      conversation: prepared.semantics, conversationState: prepared.state, answer: { text: prepared.clarification ?? "No current evidence", evidenceRefs: [], observedAt: "2026-10-11T20:00:00Z", knownUnknowns: [] } };
    fixture.records.push(record); return record;
  });
});
describe("authenticated durable conversation HTTP boundary", () => {
  it("persists and restores a thread after a new request without browser storage", async () => {
    expect((await handleThread(request({ message: "How's Acme?", threadId }))).status).toBe(202);
    const value = await (await handleThread(new Request("https://test/api/control/chat"))).json();
    expect(value.data.threadId).toBe(threadId);
    expect(value.data.turns[0].record.message).toBe("How's Acme?");
    expect(value.data.state.activeBusiness.name).toBe("Acme");
    expect(fixture.query.mock.calls[0][0]).toContain("sensitivity");
    expect(fixture.catalogConnection).toHaveBeenCalledWith(fixture.authDb);
    expect(fixture.catalogConnection).not.toHaveBeenCalledWith(
      expect.objectContaining({ transaction: expect.any(Function) })
    );
  });
  it("does not expose another user, environment or company's turns", async () => {
    const base = { id: "foreign", threadId, portfolioId: "p", companyId: "c", userId: "foreign", environment: "staging", receivedAt: "2026-10-11T20:00:00Z", conversationState: emptyState() };
    fixture.records = [base, { ...base, userId: "owner", companyId: "other" }, { ...base, userId: "owner", environment: "production" }] as OwnerIntentRecord[];
    const value = await (await handleThread(new Request(`https://test/api/control/chat?threadId=${threadId}`))).json();
    expect(value.data.turns).toEqual([]);
  });
  it("rejects browser-supplied interpretation, state and authority", async () => {
    const response = await handleThread(request({ message: "Fix it", threadId, semantics: { intent: "action_request" }, approvalState: "approved" }));
    expect(response.status).toBe(400);
    expect(fixture.submit).not.toHaveBeenCalled();
  });
  it("rejects simultaneous turns instead of letting stale state select an action", async () => {
    fixture.locked = false;
    expect((await handleThread(request({ message: "Fix that", threadId }))).status).toBe(409);
    expect(fixture.submit).not.toHaveBeenCalled();
  });
  it("blocks a viewer before model invocation and retries idempotently", async () => {
    fixture.owner = false;
    expect((await handleThread(request({ message: "How's Acme?", threadId }))).status).toBe(403);
    expect(fixture.semantic).not.toHaveBeenCalled();
    fixture.owner = true;
    await handleThread(request({ message: "How's Acme?", threadId }));
    await handleThread(request({ message: "How's Acme?", threadId }));
    expect(fixture.submit).toHaveBeenCalledTimes(1);
  });
});
