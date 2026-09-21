import { handleGetDecision, handleMutateDecision } from "@/lib/control-api/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleGetDecision(request, id);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleMutateDecision(request, id);
}
