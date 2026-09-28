import type { AuthorizationGrant } from "@/lib/authorization/grants";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { requireEnabledCapability } from "@/lib/domain/capabilities";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";
import type { MvpJobRuntime } from "@/lib/execution/mvp-job-runtime.server";
import type { OrchestrationRunRecord } from "@/lib/orchestration/contracts";
import type {
  OrchestrationExecutionAdmission
} from "@/lib/orchestration/postgres-task-job-materializer.server";
import type { GeneratedTask } from "@/lib/planning/task-generator";

export interface CapabilityExecutionAdmission
  extends OrchestrationExecutionAdmission {
  supports(capability: string): boolean;
}

export interface OrchestrationCredentialLeaseResolver {
  resolve(input: {
    run: OrchestrationRunRecord;
    task: GeneratedTask;
    operationIndex: number;
  }): Promise<string | undefined>;
}

function assertDescriptor(route: OrchestrationExecutionAdmission) {
  if (
    route.descriptor.rereadsAuthoritativeJob !== true
    || route.descriptor.persistsExecutionSpec !== true
    || route.descriptor.durableQueue !== true
    || route.descriptor.providerExecutionSeparated !== true
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Execution admission route does not satisfy the governed durable Job boundary"
    );
  }
}

export class RoutedOrchestrationExecutionAdmission
  implements OrchestrationExecutionAdmission {
  readonly descriptor = Object.freeze({
    rereadsAuthoritativeJob: true as const,
    persistsExecutionSpec: true as const,
    durableQueue: true as const,
    providerExecutionSeparated: true as const
  });

  constructor(
    private readonly routes: readonly CapabilityExecutionAdmission[]
  ) {
    if (routes.length === 0) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "At least one governed execution admission route is required"
      );
    }
    for (const route of routes) assertDescriptor(route);
  }

  async admit(input: {
    run: OrchestrationRunRecord;
    task: GeneratedTask;
    grant: AuthorizationGrant;
    operationIndex: number;
    job: JobRecord;
  }) {
    const operation = input.task.operations[input.operationIndex];
    if (!operation) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Execution admission operation index is outside the generated Task"
      );
    }

    const matches = this.routes.filter((route) =>
      route.supports(operation.capability)
    );
    if (matches.length === 0) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        `No governed executor is connected for capability: ${operation.capability}`
      );
    }
    if (matches.length !== 1) {
      throw new ControlPlaneError(
        "CONFLICT",
        `Capability has ambiguous execution authority: ${operation.capability}`
      );
    }

    await matches[0].admit(input);
  }
}

export class MvpBusinessActionExecutionAdmission
  implements CapabilityExecutionAdmission {
  readonly descriptor = Object.freeze({
    rereadsAuthoritativeJob: true as const,
    persistsExecutionSpec: true as const,
    durableQueue: true as const,
    providerExecutionSeparated: true as const
  });

  constructor(
    private readonly runtime: Pick<MvpJobRuntime, "enqueueAuthorizedBusinessAction">,
    private readonly credentialLeases?: OrchestrationCredentialLeaseResolver
  ) {}

  supports(capability: string) {
    const definition = requireEnabledCapability(capability);
    return definition.adapterBinding.startsWith("business.")
      || definition.adapterBinding === "executor.http";
  }

  async admit(input: {
    run: OrchestrationRunRecord;
    task: GeneratedTask;
    grant: AuthorizationGrant;
    operationIndex: number;
    job: JobRecord;
  }) {
    const operation = input.task.operations[input.operationIndex];
    if (!operation) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Business action admission operation index is outside the generated Task"
      );
    }
    if (!this.supports(operation.capability)) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        `Capability requires a non-business executor: ${operation.capability}`
      );
    }
    if (
      !input.task.capabilityRequirements.includes(operation.capability)
      || !input.grant.capabilityNames.includes(operation.capability)
      || input.job.authorizationConsumption?.consumptionHash
        !== input.task.authorizationConsumption.consumptionHash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Business action admission is outside exact Task/Job authorization"
      );
    }

    const credentialLeaseId = await this.credentialLeases?.resolve({
      run: input.run,
      task: input.task,
      operationIndex: input.operationIndex
    });
    if (input.run.scope.environment === "production" && !credentialLeaseId) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "Production business-action admission requires a governed credential lease"
      );
    }

    const expectedSeconds =
      input.task.resourceRequirements.execution.expectedDurationSeconds ?? 60;
    const identity = sha256Hex({
      runId: input.run.id,
      jobId: input.job.id,
      taskId: input.task.id,
      operationIndex: input.operationIndex,
      authorizationConsumptionHash:
        input.task.authorizationConsumption.consumptionHash
    });
    const request: AuthorizedBusinessActionRequest = Object.freeze({
      id: `business-action:${identity}`,
      correlationId: input.run.correlationId,
      jobId: input.job.id,
      scope: input.task.authorizationConsumption.scope,
      capability: operation.capability,
      input: operation.input,
      inputHash: sha256Hex(operation.input),
      authorizationConsumptionHash:
        input.task.authorizationConsumption.consumptionHash,
      credentialLeaseId,
      idempotencyKey: `orchestration-execution:${identity}`,
      timeoutMs: Math.min(
        900_000,
        Math.max(1_000, expectedSeconds * 1_000)
      ),
      attempt: Math.max(1, input.job.attempt || 1)
    });

    // MvpJobRuntime re-reads the authoritative queued Job, persists the exact
    // execution spec, and admits a durable queue envelope. It does not execute
    // the provider inline.
    await this.runtime.enqueueAuthorizedBusinessAction(input.job, request);
  }
}
