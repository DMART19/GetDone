import { NextResponse } from "next/server";
import { createCorrelationId } from "@/lib/control-plane/request-context";
import { readServerRuntimeEnvironment } from "@/lib/control-plane/runtime-environment.server";
import { apiSuccess } from "@/lib/control-plane/schemas";
import { getControlApiAdapter } from "@/lib/control-api/runtime.server";

export const dynamic = "force-dynamic";

export async function GET() {
  const environment = readServerRuntimeEnvironment();
  const correlationId = createCorrelationId();

  const readiness = await getControlApiAdapter().health().catch(() => null);

  return NextResponse.json(apiSuccess({
    service: "getdone-web",
    status: "ok",
    version: process.env.npm_package_version ?? "0.1.0",
    authoritativeControlPlane: readiness?.status === "ready",
    authProviderConnected: readiness?.authConnected ?? false,
    persistenceConnected: readiness?.persistenceConnected ?? false,
    aiGatewayConnected: readiness?.aiGatewayAdapterInstalled ?? false,
    durableJobEngineConnected: readiness?.durableJobStoreConnected ?? false,
    readiness: readiness?.status ?? "unavailable"
  }, { correlationId, environment }));
}
