import { getControlApiAdapter } from "@/lib/control-api/runtime.server";

export const dynamic = "force-dynamic";

// Machine readiness is intentionally separate from the diagnostic health API:
// the diagnostic endpoint may return HTTP 200 with status="unavailable".
export async function GET() {
  try {
    const health = await getControlApiAdapter().health();
    const ready = health.status === "ready"
      && health.authConnected
      && health.persistenceConnected
      && health.durableJobStoreConnected;

    return Response.json(
      { ok: ready, status: ready ? "ready" : "unavailable" },
      { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } }
    );
  } catch {
    return Response.json(
      { ok: false, status: "unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }
}
