import type { ControlPlaneTransaction, ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import type { DecisionAuthorityStore } from "@/lib/domain/decision-service";
import type { EntityStore } from "@/lib/domain/services/common";
import type { ApprovalRecord } from "@/lib/domain/services/approval-service";

export interface DecisionStores {
  decisions: DecisionAuthorityStore;
  approvals?: EntityStore<ApprovalRecord>;
}

export type DecisionTransaction = ControlPlaneTransaction<DecisionStores>;
export type DecisionTransactionManager = ControlPlaneTransactionManager<DecisionStores>;
