import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  AgentNodeEnrollmentInput,
  CreateNodeEnrollmentInput,
  NodeEnrollmentApplicationAdapter
} from "@/lib/nodes/application";
import type { ControlApiPrincipal } from "@/lib/control-api/contracts";

class UnavailableNodeEnrollmentAdapter implements NodeEnrollmentApplicationAdapter {
  private unavailable(): never {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "Node enrollment application adapter is not connected"
    );
  }

  list() {
    return Promise.reject(this.unavailable());
  }

  get() {
    return Promise.reject(this.unavailable());
  }

  create() {
    return Promise.reject(this.unavailable());
  }

  ownerAction(
    _principal: ControlApiPrincipal,
    _challengeId: string,
    _evidenceId: string,
    _idempotencyKey: string
  ) {
    return Promise.reject(this.unavailable());
  }

  cancel() {
    return Promise.reject(this.unavailable());
  }

  expire() {
    return Promise.reject(this.unavailable());
  }

  enrollAgent() {
    return Promise.reject(this.unavailable());
  }
}

const unavailable = new UnavailableNodeEnrollmentAdapter();
let installed: NodeEnrollmentApplicationAdapter | null = null;

export function installNodeEnrollmentAdapter(adapter: NodeEnrollmentApplicationAdapter) {
  installed = adapter;
}

export function resetNodeEnrollmentAdapter() {
  installed = null;
}

export function getNodeEnrollmentAdapter(): NodeEnrollmentApplicationAdapter {
  return installed ?? unavailable;
}
