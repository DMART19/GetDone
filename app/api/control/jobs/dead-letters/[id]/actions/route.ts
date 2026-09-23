import { handleDeadLetterAction } from "@/lib/execution/dead-letter-operator-http.server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleDeadLetterAction(request, id);
}
