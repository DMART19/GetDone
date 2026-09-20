import { NextResponse } from "next/server";
import { createCorrelationId } from "@/lib/control-plane/request-context";
import { readServerRuntimeEnvironment } from "@/lib/control-plane/runtime-environment.server";
import { apiSuccess } from "@/lib/control-plane/schemas";

export const dynamic = "force-dynamic";

export function GET() {
  const environment = readServerRuntimeEnvironment();
  const correlationId = createCorrelationId();

  return NextResponse.json(apiSuccess({
    service: "getdone-web",
    status: "ok",
    version: process.env.npm_package_version ?? "0.1.0",
    authoritativeControlPlane: false,
    authProviderConnected: false,
    persistenceConnected: false,
    aiGatewayConnected: false,
    durableJobEngineConnected: false
  }, { correlationId, environment }));
}
