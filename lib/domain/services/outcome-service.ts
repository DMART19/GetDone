import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import {
  executeTransitionCommand,
  type EntityStore,
  type StatefulEntity
} from "@/lib/domain/services/common";

export type OutcomeState = "recorded" | "verified" | "uncertain" | "rejected";

export interface OutcomeRecord extends StatefulEntity {
  state: OutcomeState;
  objectiveId?: string;
  taskId?: string;
  jobId?: string;
  metric: string;
  value: number | string | boolean;
  evidenceIds: readonly string[];
  confidence?: number;
}

export interface OutcomeStores {
  outcomes: EntityStore<OutcomeRecord>;
}

export class OutcomeService {
  constructor(private readonly transactions: ControlPlaneTransactionManager<OutcomeStores>) {}

  verify(id: string, command: AuthoritativeCommandEnvelope, evidenceIds: readonly string[]) {
    if (evidenceIds.length === 0) throw new ControlPlaneError("VALIDATION_FAILED", "Verified outcomes require evidence");
    return executeTransitionCommand({
      manager: this.transactions, selectStore: (stores) => stores.outcomes, entityType: "outcome", entityId: id, to: "verified", command,
      triggeringEvent: "outcome-verified", patch: () => ({ evidenceIds: [...evidenceIds] })
    });
  }

  markUncertain(id: string, command: AuthoritativeCommandEnvelope, evidenceIds: readonly string[] = []) {
    return executeTransitionCommand({
      manager: this.transactions, selectStore: (stores) => stores.outcomes, entityType: "outcome", entityId: id, to: "uncertain", command,
      triggeringEvent: "outcome-uncertain", patch: () => ({ evidenceIds: [...evidenceIds] })
    });
  }

  reject(id: string, command: AuthoritativeCommandEnvelope, evidenceIds: readonly string[] = []) {
    return executeTransitionCommand({
      manager: this.transactions, selectStore: (stores) => stores.outcomes, entityType: "outcome", entityId: id, to: "rejected", command,
      triggeringEvent: "outcome-rejected", patch: () => ({ evidenceIds: [...evidenceIds] })
    });
  }
}
