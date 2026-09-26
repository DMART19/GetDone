import { NextResponse, type NextRequest } from "next/server";
import { evaluateBrowserMutationOrigin } from "@/lib/security/browser-mutation-origin";

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

  const origin = evaluateBrowserMutationOrigin(request, process.env);
  if (!origin.allowed) {
    return Response.json(
      {
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "Browser mutation origin is not trusted"
        }
      },
      {
        status: 403,
        headers: {
          "cache-control": "no-store",
          "vary": "Origin"
        }
      }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
