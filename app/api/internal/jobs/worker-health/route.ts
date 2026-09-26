import { ControlPlaneError, toControlPlaneError } from "@/lib/control-plane/errors";
import { assertInternalWorkerToken } from "@/lib/execution/mvp-job-runtime.server";
import { getInstalledPersistentJobWorker } from "@/lib/execution/persistent-job-worker.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    assertInternalWorkerToken(request);
    const worker = getInstalledPersistentJobWorker();
    if (!worker) {
      throw new ControlPlaneError("UNAVAILABLE", "Persistent Job worker service is not installed");
    }
    const snapshot = worker.snapshot();
    const ready = worker.isReady();
    return Response.json(
      { ok: ready, worker: snapshot },
      {
        status: ready ? 200 : 503,
        headers: { "cache-control": "no-store" }
      }
    );
  } catch (error) {
    const normalized = toControlPlaneError(error);
    return Response.json(
      { ok: false, error: { code: normalized.code, message: normalized.message } },
      {
        status: normalized.status,
        headers: { "cache-control": "no-store" }
      }
    );
  }
}
