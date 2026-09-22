import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  if (
    process.env.GETDONE_PROCESS_ROLE === "job-worker"
    && request.nextUrl.pathname !== "/api/internal/jobs/worker-health"
  ) {
    return new NextResponse("Not Found", {
      status: 404,
      headers: { "cache-control": "no-store" }
    });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
