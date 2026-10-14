import { getBusinessCatalog, getBusinessContext } from "@/lib/businesses/runtime.server";
import { createCorrelationId } from "@/lib/control-plane/request-context";
import { readServerRuntimeEnvironment } from "@/lib/control-plane/runtime-environment.server";
import { toControlPlaneError } from "@/lib/control-plane/errors";
import { apiFailure, apiSuccess } from "@/lib/control-plane/schemas";

export const dynamic = "force-dynamic";

/** Authorized, read-only GetDone universe snapshot. Never invents healthy resource status. */
export async function GET(request: Request) {
  const meta = { correlationId: createCorrelationId(), environment: readServerRuntimeEnvironment() };
  const headers = { "cache-control": "private, no-store", "x-correlation-id": meta.correlationId };
  try {
    const catalog = (await getBusinessCatalog(request, true)).slice(0, 60);
    const businesses = await Promise.all(catalog.map(async (business, index) => {
      const fallback = { id: business.portfolioId, name: business.name, lastActivityAt: business.lastActivityAt, health: "Unknown" as const,
        color: ["#6db8f6", "#c5a2f9", "#f4a76b", "#57cfba", "#e4bd73", "#ec88a9"][index % 6],
        summary: "Authorized business. Operational health is not independently verified.", resources: [] as Array<{ id: string; name: string; type: string; detail: string; health: "Unknown"; status: string; updatedAt?: string }> };
      try {
        const context = await getBusinessContext(request, business.portfolioId);
        if (context.business.portfolioId !== business.portfolioId) return fallback;
        const records = context.sections.integrations.records.slice(0, 80);
        return { ...fallback, resources: records.map(record => ({
          id: record.id, name: record.title, type: "Integration", detail: "Recorded integration status: " + record.status + ". Live health unverified.",
          status: record.status, health: "Unknown" as const, updatedAt: record.updatedAt
        })) };
      } catch {
        return { ...fallback, summary: "This business is authorized, but integration details could not be retrieved." };
      }
    }));
    return Response.json(apiSuccess({ businesses, asOf: new Date().toISOString() }, meta), { headers });
  } catch (error) {
    const normalized = toControlPlaneError(error);
    return Response.json(apiFailure(normalized.code, normalized.message, meta), { status: normalized.status, headers });
  }
}
