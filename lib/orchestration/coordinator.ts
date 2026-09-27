import {
  assertOrchestrationTransition,
  isTerminalOrchestrationState,
  type ClaimedOrchestrationRun,
  type OrchestrationRun,
  type OrchestrationRunState
} from "@/lib/orchestration/contracts";

export type OrchestrationAdvanceResult =
  | Readonly<{
      kind: "transition";
      state: OrchestrationRunState;
      wake: "immediate" | "external";
      availableAt?: string;
      reason?: string;
    }>
  | Readonly<{
      kind: "defer";
      retryAt: string;
      reason: string;
    }>;

export interface OrchestrationStageHandler {
  advance(run: OrchestrationRun): Promise<OrchestrationAdvanceResult>;
}

export interface OrchestrationRuntimeStore {
  claimNext(input: {
    workerId: string;
    leaseMilliseconds: number;
    now: string;
  }): Promise<ClaimedOrchestrationRun | null>;

  transition(input: {
    claim: ClaimedOrchestrationRun;
    workerId: string;
    nextState: OrchestrationRunState;
    availableAt: string;
    scheduleResume: boolean;
    reason?: string;
    now: string;
  }): Promise<OrchestrationRun>;

  defer(input: {
    claim: ClaimedOrchestrationRun;
    workerId: string;
    retryAt: string;
    reason: string;
    now: string;
  }): Promise<void>;
}

export interface OrchestrationCoordinatorConfig {
  workerId: string;
  leaseMilliseconds: number;
  errorBackoffMilliseconds: number;
}

export class OrchestrationCoordinator {
  constructor(
    private readonly store: OrchestrationRuntimeStore,
    private readonly handler: OrchestrationStageHandler,
    private readonly config: OrchestrationCoordinatorConfig,
    private readonly now: () => Date = () => new Date()
  ) {}

  async runOnce() {
    const startedAt = this.now();
    const claim = await this.store.claimNext({
      workerId: this.config.workerId,
      leaseMilliseconds: this.config.leaseMilliseconds,
      now: startedAt.toISOString()
    });

    if (!claim) return null;

    try {
      const result = await this.handler.advance(claim.run);

      if (result.kind === "defer") {
        await this.store.defer({
          claim,
          workerId: this.config.workerId,
          retryAt: result.retryAt,
          reason: result.reason,
          now: this.now().toISOString()
        });
        return Object.freeze({
          runId: claim.run.id,
          eventId: claim.event.id,
          outcome: "deferred" as const,
          reason: result.reason,
          retryAt: result.retryAt
        });
      }

      assertOrchestrationTransition(claim.run.state, result.state);
      const next = await this.store.transition({
        claim,
        workerId: this.config.workerId,
        nextState: result.state,
        availableAt: result.availableAt ?? this.now().toISOString(),
        scheduleResume: result.wake === "immediate" && !isTerminalOrchestrationState(result.state),
        reason: result.reason,
        now: this.now().toISOString()
      });

      return Object.freeze({
        runId: next.id,
        eventId: claim.event.id,
        outcome: "transitioned" as const,
        previousState: claim.run.state,
        state: next.state,
        wake: result.wake
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryAt = new Date(
        this.now().getTime() + this.config.errorBackoffMilliseconds
      ).toISOString();

      await this.store.defer({
        claim,
        workerId: this.config.workerId,
        retryAt,
        reason: message,
        now: this.now().toISOString()
      });
      throw error;
    }
  }
}
