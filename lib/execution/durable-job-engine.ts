import type {
  DurableJobExecutionOutcomeRecord,
  DurableJobRuntimeEventRecord
} from "@/lib/execution/job-runtime-records";
import type { JobQueueEnvelope } from "@/lib/execution/job-runtime-contracts";
import {
  DurableJobWorker,
  type DurableJobExecutionHandler
} from "@/lib/execution/job-worker-runtime";
import { getTelemetry, OTEL_SEMANTIC } from "@/lib/observability/telemetry";
import type {
  DurableJobRuntimeSnapshot,
  DurableJobWorkStore
} from "@/lib/persistence/postgres/job-store";

export interface ObservableDurableJobWorkStore extends DurableJobWorkStore {
  listExecutionOutcomes(jobId: string): Promise<readonly DurableJobExecutionOutcomeRecord[]>;
  listRuntimeEvents(jobId: string): Promise<readonly DurableJobRuntimeEventRecord[]>;
}

export interface DurableJobStatus {
  runtime: DurableJobRuntimeSnapshot | null;
  outcomes: readonly DurableJobExecutionOutcomeRecord[];
  events: readonly DurableJobRuntimeEventRecord[];
}

export class DurableJobEngine {
  constructor(
    private readonly store: ObservableDurableJobWorkStore,
    private readonly worker: DurableJobWorker
  ) {}

  enqueue(envelope: JobQueueEnvelope) {
    return getTelemetry().withSpan("job.enqueue.persist", {
      [OTEL_SEMANTIC.jobId]: envelope.jobId,
      [OTEL_SEMANTIC.companyId]: envelope.scope.companyId,
      [OTEL_SEMANTIC.environment]: envelope.scope.environment
    }, async () => {
      const result = await this.store.enqueue(envelope);
      await getTelemetry().log("INFO", "job.enqueued", {
        [OTEL_SEMANTIC.jobId]: envelope.jobId,
        [OTEL_SEMANTIC.companyId]: envelope.scope.companyId,
        outcome: result.status
      });
      return result;
    });
  }

  runOnce(
    handler: DurableJobExecutionHandler,
    options: { shouldStop?: () => boolean } = {}
  ) {
    return this.worker.runOnce(handler, options);
  }

  recoverExpired(limit?: number) {
    return this.worker.recoverExpired(limit);
  }

  cancel(jobId: string, reason: string) {
    return this.worker.cancel(jobId, reason);
  }

  async status(jobId: string): Promise<DurableJobStatus> {
    const [runtime, outcomes, events] = await Promise.all([
      this.store.getRuntimeSnapshot(jobId),
      this.store.listExecutionOutcomes(jobId),
      this.store.listRuntimeEvents(jobId)
    ]);
    return Object.freeze({
      runtime,
      outcomes: Object.freeze([...outcomes]),
      events: Object.freeze([...events])
    });
  }
}
