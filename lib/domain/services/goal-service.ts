import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import {
  executeTransitionCommand,
  type EntityStore,
  type StatefulEntity
} from "@/lib/domain/services/common";

export type GoalState = "draft" | "active" | "paused" | "completed" | "cancelled";

export interface GoalRecord extends StatefulEntity {
  state: GoalState;
  title: string;
  metric: string;
  target: number;
  priority: number;
  deadline?: string;
}

export interface GoalStores {
  goals: EntityStore<GoalRecord>;
}

export class GoalService {
  constructor(private readonly transactions: ControlPlaneTransactionManager<GoalStores>) {}

  private move(id: string, to: GoalState, command: AuthoritativeCommandEnvelope, triggeringEvent: string) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.goals,
      entityType: "goal",
      entityId: id,
      to,
      command,
      triggeringEvent
    });
  }

  activate(id: string, command: AuthoritativeCommandEnvelope) {
    return this.move(id, "active", command, "goal-activated");
  }

  pause(id: string, command: AuthoritativeCommandEnvelope) {
    return this.move(id, "paused", command, "goal-paused");
  }

  complete(id: string, command: AuthoritativeCommandEnvelope) {
    return this.move(id, "completed", command, "goal-completed");
  }

  cancel(id: string, command: AuthoritativeCommandEnvelope) {
    return this.move(id, "cancelled", command, "goal-cancelled");
  }
}
