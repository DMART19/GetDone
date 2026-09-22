import { toControlPlaneError } from "@/lib/control-plane/errors";
import {
  assertInternalWorkerToken,
  getMvpJobRuntimeFromEnv
} from "@/lib/execution/mvp-job-runtime.server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertInternalWorkerToken(request);
    const results = await getMvpJobRuntimeFromEnv().runOnce();
    return Response.json({ ok: true, results }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const normalized = toControlPlaneError(error);
    return Response.json(
      { ok: false, error: { code: normalized.code, message: normalized.message } },
      { status: normalized.status, headers: { "cache-control": "no-store" } }
    );
  }
}
