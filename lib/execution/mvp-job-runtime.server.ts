import { timingSafeEqual } from "node:crypto";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { assertTrustedExecutionScopeEqual } from "@/lib/control-plane/trusted-execution-scope";
import { validateCapabilityInput } from "@/lib/domain/capabilities";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";
import { StaticBusinessActionAdapterRegistry } from "@/lib/execution/adapters/business-action-registry";
import { createOrdinaryBusinessActionBindingsFromEnv } from "@/lib/execution/adapters/ordinary-integration-registry";
import { BusinessActionExecutionOrchestrator } from "@/lib/execution/business-action-orchestrator";
import { getDurableJobEngineFromEnv } from "@/lib/execution/durable-job-engine.server";
import {
  createPersistedJobExecutionSpec,
  RoutedJobExecutionHandler
} from "@/lib/execution/job-execution-router";
import { createJobQueueEnvelope } from "@/lib/execution/job-runtime-contracts";
import { planOwnerNotification } from "@/lib/mobile/notifications";
import { PostgresBusinessActionExecutionStore } from "@/lib/persistence/postgres/execution-stores";
import { PostgresJobExecutionSpecStore } from "@/lib/persistence/postgres/job-execution-spec-store";
import { PostgresEntityStore } from "@/lib/persistence/postgres/authority-stores";
import { PostgresJobVerificationEvidenceStore } from "@/lib/persistence/postgres/worker-runtime-stores";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";

export class MvpJobRuntime {
  constructor(
    private readonly engine: ReturnType<typeof getDurableJobEngineFromEnv>,
    private readonly specs: PostgresJobExecutionSpecStore,
    private readonly handler: RoutedJobExecutionHandler,
    private readonly jobs: Pick<PostgresEntityStore<JobRecord>, "get">,
    private readonly now: () => Date = () => new Date()
  ) {}

  async enqueueAuthorizedBusinessAction(job: JobRecord, request: AuthorizedBusinessActionRequest) {
    const authoritative = await this.jobs.get(job.id);
    if (
      !authoritative
      || sha256Hex(authoritative) !== sha256Hex(job)
      || authoritative.state !== "queued"
      || authoritative.id !== request.jobId
      || authoritative.portfolioId !== request.scope.portfolioId
      || authoritative.companyId !== request.scope.companyId
      || !authoritative.authorizationGrantId
      || !authoritative.authorizationGrantHash
      || !authoritative.authorizationConsumption
      || authoritative.authorizationConsumption.consumerType !== "task"
      || authoritative.authorizationConsumption.consumerId !== authoritative.taskId
      || authoritative.authorizationConsumption.grantId !== authoritative.authorizationGrantId
      || authoritative.authorizationConsumption.grantHash !== authoritative.authorizationGrantHash
      || authoritative.authorizationConsumption.consumptionHash !== request.authorizationConsumptionHash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Capability dispatch requires the persisted authoritative queued Job and its exact Task authorization consumption"
      );
    }
    assertTrustedExecutionScopeEqual(authoritative.authorizationConsumption.scope, request.scope, {
      requireSameResource: Boolean(
        authoritative.authorizationConsumption.scope.resourceId || request.scope.resourceId
      )
    });
    validateCapabilityInput(request.capability, request.input);
    const createdAt = this.now().toISOString();
    const spec = createPersistedJobExecutionSpec({
      kind: "business-action",
      jobId: authoritative.id,
      authoritativeJobVersion: authoritative.version,
      authoritativeJobHash: sha256Hex(authoritative),
      request
    }, createdAt);
    await this.specs.put(spec);
    return this.engine.enqueue(createJobQueueEnvelope({
      id: `queue:${authoritative.id}`,
      jobId: authoritative.id,
      taskId: authoritative.taskId,
      scope: request.scope,
      authorizationConsumptionHash: request.authorizationConsumptionHash,
      idempotencyKey: `queue:${request.idempotencyKey}`,
      scheduledAt: createdAt,
      createdAt
    }));
  }

  async enqueueAuthorizedHttpAction(job: JobRecord, request: AuthorizedBusinessActionRequest) {
    if (request.capability !== "http.request") {
      throw new ControlPlaneError("FORBIDDEN", "HTTP compatibility entrypoint only accepts http.request");
    }
    return this.enqueueAuthorizedBusinessAction(job, request);
  }

  runOnce() {
    return this.engine.runOnce(this.handler);
  }

  recoverExpired(limit?: number) {
    return this.engine.recoverExpired(limit);
  }

  async ownerView(jobId: string, taskId: string) {
    const status = await this.engine.status(jobId);
    const terminal = status.outcomes.at(-1);
    return Object.freeze({
      status,
      notification: terminal ? planOwnerNotification({
        id: `job-outcome:${terminal.recordHash}`,
        attention: terminal.kind === "dead-lettered" ? "high" : "fyi",
        target: { kind: "task-result", taskId },
        sensitive: true
      }) : null
    });
  }
}

let installed: MvpJobRuntime | null = null;

export function getMvpJobRuntimeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (installed) return installed;
  const database = getPostgresRuntimeFromEnv(env).database;
  const business = new BusinessActionExecutionOrchestrator(
    new StaticBusinessActionAdapterRegistry(createOrdinaryBusinessActionBindingsFromEnv(env)),
    new PostgresBusinessActionExecutionStore(database)
  );
  const specs = new PostgresJobExecutionSpecStore(database);
  const jobs = new PostgresEntityStore<JobRecord>(database, "job");
  installed = new MvpJobRuntime(
    getDurableJobEngineFromEnv(env),
    specs,
    new RoutedJobExecutionHandler(
      specs,
      business,
      undefined,
      {
        jobs,
        verificationEvidence: new PostgresJobVerificationEvidenceStore(database)
      }
    ),
    jobs
  );
  return installed;
}

export function assertInternalWorkerToken(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  const expected = env.GETDONE_INTERNAL_WORKER_TOKEN?.trim();
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!expected || !actual) throw new ControlPlaneError("UNAUTHENTICATED", "Internal worker token is required");
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new ControlPlaneError("UNAUTHENTICATED", "Internal worker token is invalid");
  }
}

export function resetMvpJobRuntimeForTests() {
  installed = null;
}
