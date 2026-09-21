import { handleNodeEnrollmentAction } from "@/lib/nodes/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleNodeEnrollmentAction(request, id);
}
