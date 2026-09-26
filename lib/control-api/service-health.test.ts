import { describe, expect, it } from "vitest";
import {
  buildServiceHealth,
  unavailableControlApiHealth
} from "@/lib/control-api/service-health";
import { CONTROL_API_SURFACE_VERSION } from "@/lib/control-api/contracts";

describe("GetDone web service health", () => {
  it("keeps development healthy while authoritative services are intentionally unavailable", () => {
    expect(buildServiceHealth({
      environment: "development",
      version: "0.1.0",
      controlApi: unavailableControlApiHealth()
    })).toMatchObject({
      service: "getdone-web",
      status: "ok",
      authoritativeControlPlane: false,
      authProviderConnected: false,
      persistenceConnected: false,
      durableJobEngineConnected: false,
      controlApiStatus: "unavailable",
      controlApiSurfaceVersion: CONTROL_API_SURFACE_VERSION
    });
  });

  it("reports connected production core services from Control API health", () => {
    expect(buildServiceHealth({
      environment: "production",
      version: "0.1.0",
      controlApi: {
        service: "getdone-control-api",
        surfaceVersion: CONTROL_API_SURFACE_VERSION,
        status: "ready",
        authConnected: true,
        persistenceConnected: true,
        aiGatewayAdapterInstalled: false,
        durableJobStoreConnected: true
      }
    })).toMatchObject({
      status: "ok",
      authoritativeControlPlane: true,
      authProviderConnected: true,
      persistenceConnected: true,
      aiGatewayConnected: false,
      durableJobEngineConnected: true,
      controlApiStatus: "ready"
    });
  });

  it("reports degraded production health when a required core service is unavailable", () => {
    expect(buildServiceHealth({
      environment: "production",
      version: "0.1.0",
      controlApi: {
        service: "getdone-control-api",
        surfaceVersion: CONTROL_API_SURFACE_VERSION,
        status: "degraded",
        authConnected: true,
        persistenceConnected: true,
        aiGatewayAdapterInstalled: false,
        durableJobStoreConnected: false
      }
    }).status).toBe("degraded");
  });
});
