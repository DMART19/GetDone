import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  ControlApiApplicationAdapter,
  ControlApiHealth
} from "@/lib/control-api/contracts";

class UnavailableControlApiAdapter implements ControlApiApplicationAdapter {
  private unavailable(): never {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "Control API adapter is not connected to authoritative auth/persistence"
    );
  }

  async authenticate(): Promise<never> { return this.unavailable(); }
  async health(): Promise<ControlApiHealth> {
    return {
      service: "getdone-control-api",
      surfaceVersion: "1.0.0",
      status: "unavailable",
      authConnected: false,
      persistenceConnected: false,
      aiGatewayAdapterInstalled: false,
      durableJobStoreConnected: false
    };
  }
  async submitOwnerIntent(): Promise<never> { return this.unavailable(); }
  async listDecisions(): Promise<never> { return this.unavailable(); }
  async getDecision(): Promise<never> { return this.unavailable(); }
  async mutateDecision(): Promise<never> { return this.unavailable(); }
  async listResources(): Promise<never> { return this.unavailable(); }
  async getResource(): Promise<never> { return this.unavailable(); }
  async enrollResource(): Promise<never> { return this.unavailable(); }
  async listJobs(): Promise<never> { return this.unavailable(); }
  async getJob(): Promise<never> { return this.unavailable(); }
  async getJobResult(): Promise<never> { return this.unavailable(); }
  async listVerifications(): Promise<never> { return this.unavailable(); }
  async getVerification(): Promise<never> { return this.unavailable(); }
}

const unavailableAdapter = new UnavailableControlApiAdapter();
let installedAdapter: ControlApiApplicationAdapter | null = null;

export function installControlApiAdapter(adapter: ControlApiApplicationAdapter) {
  installedAdapter = adapter;
}

export function resetControlApiAdapter() {
  installedAdapter = null;
}

export function getControlApiAdapter() {
  return installedAdapter ?? unavailableAdapter;
}
