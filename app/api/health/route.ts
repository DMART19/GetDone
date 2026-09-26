import { NextResponse } from "next/server";
import { getControlApiAdapter } from "@/lib/control-api/runtime.server";
import {
  buildServiceHealth,
  unavailableControlApiHealth
} from "@/lib/control-api/service-health";
import { createCorrelationId } from "@/lib/control-plane/request-context";
import { readServerRuntimeEnvironment } from "@/lib/control-plane/runtime-environment.server";
import { apiSuccess } from "@/lib/control-plane/schemas";

export const dynamic = "force-dynamic";

export async function GET() {
  const environment = readServerRuntimeEnvironment();
  const correlationId = createCorrelationId();

  let controlApi = unavailableControlApiHealth();
  try {
    controlApi = await getControlApiAdapter().health();
  } catch {
    // Health reporting must fail closed without leaking connection details.
  }

  const health = buildServiceHealth({
    environment,
    version: process.env.npm_package_version ?? "0.1.0",
    controlApi
  });

  return NextResponse.json(
    apiSuccess(health, { correlationId, environment }),
    {
      headers: {
        "cache-control": "no-store",
        "x-correlation-id": correlationId
      }
    }
  );
}
