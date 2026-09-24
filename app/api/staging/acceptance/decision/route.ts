import { z } from "zod";
import { createAcceptanceDecision } from "@/lib/staging/browser-acceptance.server";
import { toControlPlaneError } from "@/lib/control-plane/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  correlationId: z.string().min(8).max(200),
  requiresStepUp: z.boolean().optional()
});

export async function POST(request: Request) {
  try {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json(
        { ok: false, error: { code: "VALIDATION_FAILED", message: "Invalid staging acceptance decision payload" } },
        { status: 400 }
      );
    }
    const decision = await createAcceptanceDecision(
      request,
      parsed.data.correlationId,
      parsed.data.requiresStepUp ?? false
    );
    return Response.json({ ok: true, data: decision }, {
      status: 201,
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
