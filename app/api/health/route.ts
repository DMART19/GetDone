import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    service: "getdone-web",
    status: "ok",
    version: process.env.npm_package_version ?? "0.1.0",
    environment: process.env.NEXT_PUBLIC_APP_ENV ?? process.env.NODE_ENV ?? "unknown",
    authoritativeControlPlane: false
  });
}
