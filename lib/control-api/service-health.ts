import {
  CONTROL_API_SURFACE_VERSION,
  type ControlApiHealth
} from "@/lib/control-api/contracts";

export interface GetDoneServiceHealth {
  service: "getdone-web";
  status: "ok" | "degraded";
  version: string;
  authoritativeControlPlane: boolean;
  authProviderConnected: boolean;
  persistenceConnected: boolean;
  aiGatewayConnected: boolean;
  durableJobEngineConnected: boolean;
  controlApiStatus: ControlApiHealth["status"];
  controlApiSurfaceVersion: string;
}

export function unavailableControlApiHealth(): ControlApiHealth {
  return {
    service: "getdone-control-api",
    surfaceVersion: CONTROL_API_SURFACE_VERSION,
    status: "unavailable",
    authConnected: false,
    persistenceConnected: false,
    aiGatewayAdapterInstalled: false,
    durableJobStoreConnected: false
  };
}

export function buildServiceHealth(input: {
  environment: "development" | "staging" | "production";
  version: string;
  controlApi: ControlApiHealth;
}): GetDoneServiceHealth {
  const authoritativeControlPlane =
    input.controlApi.authConnected && input.controlApi.persistenceConnected;
  const authoritativeEnvironment = input.environment !== "development";
  const coreReady =
    authoritativeControlPlane
    && input.controlApi.durableJobStoreConnected
    && input.controlApi.status === "ready";

  return {
    service: "getdone-web",
    status: authoritativeEnvironment && !coreReady ? "degraded" : "ok",
    version: input.version,
    authoritativeControlPlane,
    authProviderConnected: input.controlApi.authConnected,
    persistenceConnected: input.controlApi.persistenceConnected,
    aiGatewayConnected: input.controlApi.aiGatewayAdapterInstalled,
    durableJobEngineConnected: input.controlApi.durableJobStoreConnected,
    controlApiStatus: input.controlApi.status,
    controlApiSurfaceVersion: input.controlApi.surfaceVersion
  };
}
