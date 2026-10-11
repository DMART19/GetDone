import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOwnerReadRepository } from "./runtime-repository.server";
import { developmentOwnerRepository } from "./repository";

const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));
const fetchMock = vi.fn<typeof fetch>();
const objective = {
  id: "objective-1", normalizedGoal: "Improve uptime", desiredOutcome: "99.9%",
  status: "queued", priority: "high", riskLevel: "low", constraints: ["No downtime"],
  successCriteria: ["SLO met"], relationship: "independent", dependsOnObjectiveIds: [],
  progress: [{ message: "Accepted" }], createdAt: "2026-10-10T00:00:00Z"
};
const resource = {
  id: "node_one", type: "server", state: "ready", capabilityNames: ["http"],
  environmentPermissions: ["staging"], dataClassesAllowed: ["public"],
  trustClass: "verified", version: 2
};
function respond(data: unknown, status = 200) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, data, correlationId: "read-1", environment: "staging" }), { status }));
}
function fail(code: string) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: { code, message: "Read denied" }, correlationId: "read-1", environment: "staging" }), { status: 403 }));
}
beforeEach(() => {
  vi.stubEnv("GETDONE_RUNTIME_ENV", "staging");
  vi.stubEnv("GETDONE_DATA_MODE", "authoritative");
  vi.stubEnv("GETDONE_CONTROL_API_URL", "");
  vi.stubGlobal("fetch", fetchMock);
  request.headers = new Headers({ host: "getdone.test", cookie: "session=synthetic", authorization: "Bearer synthetic", "x-getdone-portfolio-id": "portfolio-1", "x-untrusted": "do-not-forward" });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); fetchMock.mockReset(); });

describe("authoritative owner reads", () => {
  it("forwards only request credentials and tenant selection, bypassing caches", async () => {
    respond([objective]);
    const repo = await getOwnerReadRepository();
    expect(await repo.listObjectives()).toEqual([expect.objectContaining({ id: objective.id, title: objective.normalizedGoal, constraints: objective.constraints, progress: objective.progress })]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://getdone.test/api/control/objectives");
    expect(init).toMatchObject({ method: "GET", cache: "no-store" });
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({ accept: "application/json", cookie: "session=synthetic", authorization: "Bearer synthetic", "x-getdone-portfolio-id": "portfolio-1" });
    respond(objective);
    expect(await repo.getObjective("a/b")).toMatchObject({ title: "Improve uptime" });
    expect(String(fetchMock.mock.calls[1][0])).toContain("/objectives/a%2Fb");
  });
  it.each(["https://control.test", "https://control.test/"])("supports configured origin %s without ambient headers", async (origin) => {
    vi.stubEnv("GETDONE_CONTROL_API_URL", origin);
    request.headers = new Headers();
    respond([]);
    await (await getOwnerReadRepository()).listObjectives();
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://control.test/api/control/objectives");
  });
  it("uses the first forwarded host and protocol", async () => {
    request.headers = new Headers({ "x-forwarded-host": "edge.test, proxy.test", "x-forwarded-proto": "http, https" });
    respond([]);
    await (await getOwnerReadRepository()).listObjectives();
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://edge.test/api/control/objectives");
  });
  it("fails closed when no authoritative origin is available", async () => {
    request.headers = new Headers();
    await expect((await getOwnerReadRepository()).listObjectives()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([null, [], { ok: true }, { ok: true, correlationId: "c", environment: "unknown" }, "not json"])("rejects malformed API response %j", async (body) => {
    fetchMock.mockResolvedValue(new Response(typeof body === "string" ? body : JSON.stringify(body)));
    await expect((await getOwnerReadRepository()).listObjectives()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it("rejects HTTP errors even when the envelope claims success", async () => {
    respond([], 500);
    await expect((await getOwnerReadRepository()).listObjectives()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it.each(["getObjective", "getDecision", "getResource"] as const)("%s converts only NOT_FOUND to null", async (method) => {
    const repo = await getOwnerReadRepository();
    fail("NOT_FOUND");
    expect(await repo[method]("missing")).toBeNull();
    fail("FORBIDDEN");
    await expect(repo[method]("foreign")).rejects.toMatchObject({ code: "FORBIDDEN", message: "Read denied" });
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(repo[method]("offline")).rejects.toThrow("offline");
  });
  it("permits seeds only in explicitly configured development", async () => {
    vi.stubEnv("GETDONE_RUNTIME_ENV", "development");
    vi.stubEnv("GETDONE_DATA_MODE", "development-seed");
    expect(await getOwnerReadRepository()).toBe(developmentOwnerRepository);
    vi.stubEnv("GETDONE_RUNTIME_ENV", "production");
    expect(await getOwnerReadRepository()).not.toBe(developmentOwnerRepository);
    respond([]);
    expect(await (await getOwnerReadRepository()).listObjectives()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("owner presentation contracts", () => {
  it.each([
    ["invalid", false, "Recently"], ["2026-10-11T11:59:59Z", false, "1m ago"],
    ["2026-10-11T10:00:00Z", true, "2h ago"], ["2026-10-09T12:00:00Z", false, "2d ago"]
  ])("maps decision age and approval requirements for %s", async (updatedAt, requiresStepUp, age) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-11T12:00:00Z"));
    respond([{ id: "review:new_node", status: "pending", updatedAt, requiresStepUp }]);
    const [decision] = await (await getOwnerReadRepository()).listDecisions();
    expect(decision).toMatchObject({ title: "Review New Node", age, priority: requiresStepUp ? "high" : "normal", category: "growth" });
  });
  it.each(["resource", "growth", "incident", "budget", "outreach"])("preserves explicit decision presentation for %s", async (category) => {
    const presentation = { title: "Review capacity", subtitle: "Pool A", priority: "fyi", category, rationale: "Demand increased", impact: ["More capacity"], evidence: ["signal-1"], blastRadius: "one node", objectiveId: "goal-1", actionLabel: "Approve" };
    respond({ id: "decision-1", status: "pending", requiresStepUp: true, updatedAt: "invalid", ...presentation });
    expect(await (await getOwnerReadRepository()).getDecision("decision-1")).toMatchObject(presentation);
  });
  it.each([
    ["ready", "healthy"], ["degraded", "degraded"], ["saturated", "degraded"], ["draining", "degraded"],
    ["unreachable", "offline"], ["failed", "offline"], ["quarantined", "offline"], ["disabled", "offline"], ["discovered", "online"]
  ])("maps resource state %s into owner health", async (state, health) => {
    respond([{ ...resource, state }]);
    expect(await (await getOwnerReadRepository()).listResources()).toEqual([expect.objectContaining({ name: "Node One", health, autoScheduling: state === "ready", environments: ["Staging"] })]);
  });
  it.each(["gpu", "storage", "network", "cloud", "server"])("maps %s resource type and preserves its presentation", async (type) => {
    const presentation = { name: "Node A", role: "Compute", provider: "Provider A", location: "EU", customerDataPolicy: "Public only", reliabilityTier: "Gold" };
    respond({ ...resource, type, ...presentation });
    expect(await (await getOwnerReadRepository()).getResource("node_one")).toMatchObject({ ...presentation, icon: type, kind: type === "gpu" ? "compute" : type });
  });
  it("uses registry provider and region without inventing authorization or usage", async () => {
    respond({ ...resource, providerId: "provider-1", region: "eu", dataClassesAllowed: [] });
    expect(await (await getOwnerReadRepository()).getResource("node_one")).toMatchObject({ provider: "provider-1", location: "eu", customerDataPolicy: "No data classes authorized", workloads: { running: 0, queued: 0, utilization: 0 } });
  });
  it.each([[], [resource], [{ ...resource, state: "failed" }]])("summarizes observed registry health without fabricating spend", async (...items) => {
    const resources = items.flat();
    respond(resources);
    expect(await (await getOwnerReadRepository()).getResourceSummary()).toMatchObject({ resourceCount: resources.length, health: resources.some(r => r.state === "failed") ? "Needs attention" : "Healthy", monthlySpend: "Not connected" });
  });
});
