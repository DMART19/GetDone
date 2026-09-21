import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  AuthorizedBusinessActionRequest,
  BusinessActionAdapter
} from "@/lib/execution/adapters/business-action";
import type { BusinessActionAdapterRegistry } from "@/lib/execution/business-action-orchestrator";

export interface BusinessActionAdapterBinding {
  capability: string;
  adapter: BusinessActionAdapter;
}

export class StaticBusinessActionAdapterRegistry implements BusinessActionAdapterRegistry {
  private readonly byCapability = new Map<string, BusinessActionAdapter>();

  constructor(bindings: readonly BusinessActionAdapterBinding[]) {
    for (const binding of bindings) {
      if (!binding.capability.trim()) {
        throw new ControlPlaneError("VALIDATION_FAILED", "Business action capability binding is required");
      }
      if (this.byCapability.has(binding.capability)) {
        throw new ControlPlaneError(
          "CONFLICT",
          `Business action capability ${binding.capability} has multiple adapters`
        );
      }
      this.byCapability.set(binding.capability, binding.adapter);
    }
  }

  async resolve(request: AuthorizedBusinessActionRequest) {
    return this.byCapability.get(request.capability) ?? null;
  }
}
