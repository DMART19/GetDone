import type { ControlPlaneTransaction, ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import type { DecisionAuthorityStore } from "@/lib/domain/decision-service";

export interface DecisionStores {
  decisions: DecisionAuthorityStore;
}

export type DecisionTransaction = ControlPlaneTransaction<DecisionStores>;
export type DecisionTransactionManager = ControlPlaneTransactionManager<DecisionStores>;
