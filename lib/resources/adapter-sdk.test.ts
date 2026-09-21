import { describe, expect, it } from "vitest";
import {
  assertResourceAdapterConformance,
  assertResourceAdapterEvidence,
  createResourceAdapterEvidence
} from "@/lib/resources/adapter-sdk";
import { DevelopmentMockResourceAdapter } from "@/lib/resources/development-mock-resource-adapter";

const context = {
  scope: { portfolioId: "p1", companyId: "c1", environment: "development" as const },
  correlationId: "correlation-1",
  providerId: "mock-provider"
};

describe("Phase 38 Resource Adapter SDK", () => {
  it("runs the complete provider-neutral lifecycle through conformance", async () => {
    const result = await assertResourceAdapterConformance({
      adapter: new DevelopmentMockResourceAdapter(
        () => new Date("2026-09-20T22:00:00Z")
      ),
      context,
      fixtureTargetId: "mock-resource-1"
    });
    expect(result.conformancePassed).toBe(true);
    expect(result.lifecycleExercised).toBe(true);
    expect(result.authoritative).toBe(false);
    expect(result.evidenceHashes).toHaveLength(13);
  });

  it("keeps all provider evidence non-authoritative and scope-bound", () => {
    const adapter = new DevelopmentMockResourceAdapter();
    const evidence = createResourceAdapterEvidence({
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      context,
      observedAt: "2026-09-20T22:00:00Z",
      payload: { accepted: true }
    });
    expect(assertResourceAdapterEvidence(evidence, adapter, context).authoritative).toBe(false);
    expect(evidence.scope.companyId).toBe("c1");
    expect(evidence.correlationId).toBe("correlation-1");
  });

  it("rejects forged provider evidence that claims authority", () => {
    const adapter = new DevelopmentMockResourceAdapter();
    const evidence = createResourceAdapterEvidence({
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      context,
      observedAt: "2026-09-20T22:00:00Z",
      payload: { accepted: true }
    });
    expect(() => assertResourceAdapterEvidence(
      { ...evidence, authoritative: true } as never,
      adapter,
      context
    )).toThrow(/forged|authority/i);
  });

  it("rejects evidence replayed into another company or correlation", () => {
    const adapter = new DevelopmentMockResourceAdapter();
    const evidence = createResourceAdapterEvidence({
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      context,
      observedAt: "2026-09-20T22:00:00Z",
      payload: { accepted: true }
    });
    expect(() => assertResourceAdapterEvidence(evidence, adapter, {
      ...context,
      scope: { ...context.scope, companyId: "c2" }
    })).toThrow(/tenant|scope/i);
    expect(() => assertResourceAdapterEvidence(evidence, adapter, {
      ...context,
      correlationId: "correlation-other"
    })).toThrow(/correlation|scope/i);
  });

  it("rejects provider/context mismatch", async () => {
    await expect(assertResourceAdapterConformance({
      adapter: new DevelopmentMockResourceAdapter(),
      context: { ...context, providerId: "other-provider" },
      fixtureTargetId: "mock-resource-1"
    })).rejects.toThrow(/provider\/context mismatch/i);
  });

  it("rejects DEVELOPMENT mock adapters outside development", async () => {
    await expect(assertResourceAdapterConformance({
      adapter: new DevelopmentMockResourceAdapter(),
      context: {
        ...context,
        scope: { ...context.scope, environment: "production" as const }
      },
      fixtureTargetId: "mock-resource-1"
    })).rejects.toThrow(/DEVELOPMENT-only/i);
  });
});
