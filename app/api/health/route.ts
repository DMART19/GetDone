import { NextResponse } from "next/server";
import { createCorrelationId } from "@/lib/control-plane/request-context";
import { readServerRuntimeEnvironment } from "@/lib/control-plane/runtime-environment.server";
import { apiSuccess } from "@/lib/control-plane/schemas";

export const dynamic = "force-dynamic";

export function GET() {
  const environment = readServerRuntimeEnvironment();
  const correlationId = createCorrelationId();
  const acceptanceForcedUnhealthy =
    environment !== "production"
    && process.env.GETDONE_DEPLOYMENT_ACCEPTANCE_MODE === "force-unhealthy";

  const body = apiSuccess({
    service: "getdone-web",
    status: acceptanceForcedUnhealthy ? "acceptance-forced-unhealthy" : "ok",
    version: process.env.npm_package_version ?? "0.1.0",
    authoritativeControlPlane: false,
    authProviderConnected: false,
    persistenceConnected: false,
    aiGatewayConnected: false,
    durableJobEngineConnected: false
  }, { correlationId, environment });

  return NextResponse.json(
    body,
    acceptanceForcedUnhealthy ? { status: 503 } : undefined
  );
}
