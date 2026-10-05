import { handleOwnerIntentStatus } from "@/lib/control-api/http";

export const dynamic = "force-dynamic";

export function GET(request: Request, context: { params: Promise<{ intentId: string }> }) {
  return context.params.then(({ intentId }) => handleOwnerIntentStatus(request, intentId));
}
