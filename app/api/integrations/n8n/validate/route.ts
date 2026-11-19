import { validateN8nEnvelope } from "@/lib/operations/n8n-envelope-validator";
import { ControlPlaneError } from "@/lib/control-plane/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const result = validateN8nEnvelope(
      await request.json(),
      request.headers.get("x-getdone-signature")
    );
    return Response.json(
      { allowed: true, ...result },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    const status = error instanceof ControlPlaneError && error.code === "UNAVAILABLE" ? 503 : 403;
    return Response.json(
      { allowed: false, error: "n8n request denied" },
      { status, headers: { "cache-control": "no-store" } }
    );
  }
}
