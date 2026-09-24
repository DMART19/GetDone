import { z } from "zod";
import { executeAcceptanceDecision } from "@/lib/staging/browser-acceptance.server";
import { toControlPlaneError } from "@/lib/control-plane/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  decisionId: z.string().min(1).max(240)
});

export async function POST(request: Request) {
  try {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json(
        { ok: false, error: { code: "VALIDATION_FAILED", message: "Invalid staging acceptance execution payload" } },
        { status: 400 }
      );
    }
    const result = await executeAcceptanceDecision(request, parsed.data.decisionId);
    return Response.json({ ok: true, data: result }, {
      headers: { "cache-control": "no-store" }
    });
  } catch (error) {
    const normalized = toControlPlaneError(error);
    return Response.json(
      { ok: false, error: { code: normalized.code, message: normalized.message } },
      { status: normalized.status, headers: { "cache-control": "no-store" } }
    );
  }
}
