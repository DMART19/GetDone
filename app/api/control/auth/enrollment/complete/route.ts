import { handleOwnerEnrollment } from "@/lib/auth/owner-enrollment-http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function POST(request: Request) { return handleOwnerEnrollment(request, "complete"); }
