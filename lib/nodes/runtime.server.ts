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

  list(_principal: ControlApiPrincipal) {
    return Promise.reject(this.unavailable());
  }

  get(_principal: ControlApiPrincipal, _id: string) {
    return Promise.reject(this.unavailable());
  }

  create(_principal: ControlApiPrincipal, _input: CreateNodeEnrollmentInput) {
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

  cancel(
    _principal: ControlApiPrincipal,
    _challengeId: string,
    _idempotencyKey: string
  ) {
    return Promise.reject(this.unavailable());
  }

  expire(
    _principal: ControlApiPrincipal,
    _challengeId: string,
    _idempotencyKey: string
  ) {
    return Promise.reject(this.unavailable());
  }

  enrollAgent(_input: AgentNodeEnrollmentInput) {
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
