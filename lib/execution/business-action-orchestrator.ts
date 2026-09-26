import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  assertAuthorizedBusinessActionRequest,
  assertBusinessActionAdapterResult,
  assertBusinessActionStatus,
  type AuthorizedBusinessActionRequest,
  type BusinessActionAdapter,
  type BusinessActionRetryClass,
  type BusinessActionStatus
} from "@/lib/execution/adapters/business-action";
import { createVerificationEvidence, type VerificationEvidence } from "@/lib/verification/verification";
import { validateCapabilityOutput } from "@/lib/domain/capabilities";
import type { ProviderConcurrencyGate } from "@/lib/execution/provider-concurrency.server";
import type { BusinessActionCredentialBroker } from "@/lib/credentials/runtime-broker";
import type { BusinessActionExecutionContext } from "@/lib/execution/adapters/business-action";
import { getTelemetry, OTEL_SEMANTIC } from "@/lib/observability/telemetry";

export const BUSINESS_ACTION_ORCHESTRATOR_VERSION = "1.0.0";

export interface BusinessActionAdapterRegistry {
  resolve(request: AuthorizedBusinessActionRequest): Promise<BusinessActionAdapter | null>;
}

export type BusinessActionExecutionState =
  | "accepted"
  | "pending"
  | "running"
  | "completed"
  | "rejected"
  | "failed"
  | "cancelled";

export interface BusinessActionExecutionRecord {
  requestId: string;
  correlationId?: string;
  jobId: string;
  requestHash: string;
  adapterId: string;
  adapterVersion: string;
  providerOperationId?: string;
  state: BusinessActionExecutionState;
  adapterResultHash: string;
  latestStatusHash?: string;
  output?: unknown;
  outputHash?: string;
  retryable: boolean;
  retryClass?: BusinessActionRetryClass;
  updatedAt: string;
  recordHash: string;
}

export interface BusinessActionExecutionStore {
  get(requestId: string): Promise<BusinessActionExecutionRecord | null>;
  save(record: BusinessActionExecutionRecord, expectedRecordHash?: string): Promise<void>;
}

export interface BusinessActionExecutionResult {
  record: BusinessActionExecutionRecord;
  verificationEvidence?: VerificationEvidence;
}

function createRecord(
  input: Omit<BusinessActionExecutionRecord, "recordHash">
): BusinessActionExecutionRecord {
  return Object.freeze({ ...input, recordHash: sha256Hex(input) });
}

function assertStatusIdentity(
  adapter: BusinessActionAdapter,
  request: AuthorizedBusinessActionRequest,
  providerOperationId: string,
  status: BusinessActionStatus
) {
  assertBusinessActionStatus(status);
  if (
    status.adapterId !== adapter.id
    || status.adapterVersion !== adapter.version
    || status.requestId !== request.id
    || status.providerOperationId !== providerOperationId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Business action status identity does not match adapter/request lineage"
    );
  }
}

function verificationFor(
  request: AuthorizedBusinessActionRequest,
  record: BusinessActionExecutionRecord
): VerificationEvidence | undefined {
  if (!["completed", "failed", "cancelled"].includes(record.state)) return undefined;
  return createVerificationEvidence({
    id: `business-action-evidence:${request.id}:${record.recordHash}`,
    correlationId: request.correlationId,
    portfolioId: request.scope.portfolioId,
    companyId: request.scope.companyId,
    subject: { type: "job", id: request.jobId },
    strategy: "business",
    result: record.state === "completed" ? "pass" : "fail",
    sourceType: "provider",
    sourceId: `${record.adapterId}:${record.providerOperationId ?? request.id}`,
    independenceKey: record.providerOperationId ?? request.id,
    observedAt: record.updatedAt,
    payloadHash: record.latestStatusHash ?? record.adapterResultHash,
    provenance: `business-action:${record.adapterId}:${request.id}`
  });
}

export class BusinessActionExecutionOrchestrator {
  constructor(
    private readonly adapters: BusinessActionAdapterRegistry,
    private readonly store: BusinessActionExecutionStore,
    private readonly options: {
      maxStatusPolls?: number;
      pollIntervalMs?: number;
      sleep?: (milliseconds: number) => Promise<void>;
      now?: () => Date;
      providerConcurrencyGate?: ProviderConcurrencyGate;
      credentialBroker?: BusinessActionCredentialBroker;
    } = {}
  ) {}

  private async credentialContext(
    request: AuthorizedBusinessActionRequest,
    adapter: BusinessActionAdapter
  ): Promise<BusinessActionExecutionContext | undefined> {
    const requirement = adapter.credentialRequirement?.(request) ?? null;
    if (!requirement) return undefined;
    if (!this.options.credentialBroker) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "Credential-bearing business action requires the governed credential broker"
      );
    }
    const credential = await this.options.credentialBroker.resolve({ request, requirement });
    return Object.freeze({ credential });
  }

  private providerCall<T>(
    request: AuthorizedBusinessActionRequest,
    adapter: BusinessActionAdapter,
    operation: "execute" | "status" | "cancel",
    call: () => Promise<T>
  ) {
    const telemetry = getTelemetry();
    const invoke = () => telemetry.withSpan("provider.call", {
      [OTEL_SEMANTIC.jobId]: request.jobId,
      [OTEL_SEMANTIC.provider]: adapter.id,
      [OTEL_SEMANTIC.operation]: operation,
      [OTEL_SEMANTIC.capability]: request.capability,
      [OTEL_SEMANTIC.companyId]: request.scope.companyId,
      [OTEL_SEMANTIC.environment]: request.scope.environment,
      [OTEL_SEMANTIC.correlationId]: request.correlationId ?? null
    }, async () => {
      const startedAt = Date.now();
      try {
        const result = await call();
        await telemetry.histogram("getdone.provider.call.duration", Date.now() - startedAt, "ms", {
          [OTEL_SEMANTIC.provider]: adapter.id,
          [OTEL_SEMANTIC.operation]: operation,
          [OTEL_SEMANTIC.capability]: request.capability
        });
        await telemetry.counter("getdone.provider.call.total", 1, {
          [OTEL_SEMANTIC.provider]: adapter.id,
          [OTEL_SEMANTIC.operation]: operation,
          outcome: "success"
        });
        return result;
      } catch (error) {
        await telemetry.counter("getdone.provider.call.total", 1, {
          [OTEL_SEMANTIC.provider]: adapter.id,
          [OTEL_SEMANTIC.operation]: operation,
          outcome: "error"
        });
        throw error;
      }
    });
    const gate = this.options.providerConcurrencyGate;
    if (!gate) return invoke();
    return gate.withPermit({
      providerKey: adapter.id,
      requestId: request.id,
      portfolioId: request.scope.portfolioId,
      companyId: request.scope.companyId,
      operation
    }, invoke);
  }

  async execute(request: AuthorizedBusinessActionRequest): Promise<BusinessActionExecutionResult> {
    assertAuthorizedBusinessActionRequest(request);
    const requestHash = sha256Hex(request);
    const existing = await this.store.get(request.id);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ControlPlaneError(
          "IDEMPOTENCY_CONFLICT",
          "Business action request ID was reused with different authorized input"
        );
      }
      if (
        ["completed", "rejected", "cancelled"].includes(existing.state)
        || (existing.state === "failed" && (!existing.retryable || existing.providerOperationId))
      ) {
        return { record: existing, verificationEvidence: verificationFor(request, existing) };
      }
    }

    const adapter = await this.adapters.resolve(request);
    if (!adapter) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        `No business action adapter is installed for capability ${request.capability}`
      );
    }

    if (existing?.providerOperationId) {
      return this.pollAccepted(request, adapter, existing);
    }

    const result = await this.providerCall(
      request,
      adapter,
      "execute",
      async () => adapter.execute(request, await this.credentialContext(request, adapter))
    );
    assertBusinessActionAdapterResult(result);
    if (
      result.adapterId !== adapter.id
      || result.adapterVersion !== adapter.version
      || result.requestId !== request.id
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Business action adapter result identity does not match invocation"
      );
    }

    const record = createRecord({
      requestId: request.id,
      correlationId: request.correlationId,
      jobId: request.jobId,
      requestHash,
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      providerOperationId: result.providerOperationId,
      state: result.status === "accepted" ? "accepted" : result.status,
      adapterResultHash: result.resultHash,
      output: result.output === undefined
        ? undefined
        : validateCapabilityOutput(request.capability, result.output),
      outputHash: result.outputHash,
      retryable: result.retryable,
      retryClass: result.retryClass,
      updatedAt: result.observedAt
    });
    await this.store.save(record, existing?.recordHash);
    await getTelemetry().counter("getdone.provider.result.total", 1, {
      [OTEL_SEMANTIC.provider]: adapter.id,
      [OTEL_SEMANTIC.retryClass]: result.retryClass ?? "none",
      outcome: result.status
    });

    if (result.status !== "accepted" || !result.providerOperationId) {
      return { record, verificationEvidence: verificationFor(request, record) };
    }

    return this.pollAccepted(request, adapter, record);
  }

  async cancel(
    request: AuthorizedBusinessActionRequest,
    reason: string
  ): Promise<BusinessActionExecutionResult> {
    assertAuthorizedBusinessActionRequest(request);
    const record = await this.store.get(request.id);
    if (!record || !record.providerOperationId) {
      throw new ControlPlaneError("NOT_FOUND", "Business action execution was not found");
    }
    const lineageRequest = request.correlationId || !record.correlationId
      ? request
      : Object.freeze({ ...request, correlationId: record.correlationId });
    if (record.requestHash !== sha256Hex(lineageRequest)) {
      throw new ControlPlaneError("IDEMPOTENCY_CONFLICT", "Cancellation request does not match persisted action");
    }
    const adapter = await this.adapters.resolve(lineageRequest);
    if (!adapter?.cancel) {
      throw new ControlPlaneError("UNAVAILABLE", "Business action adapter does not support cancellation");
    }
    const status = await this.providerCall(
      lineageRequest,
      adapter,
      "cancel",
      async () => adapter.cancel!({
        requestId: lineageRequest.id,
        providerOperationId: record.providerOperationId!,
        reason
      }, await this.credentialContext(lineageRequest, adapter))
    );
    assertStatusIdentity(adapter, lineageRequest, record.providerOperationId, status);
    const next = createRecord({
      ...record,
      state: status.state,
      latestStatusHash: status.statusHash,
      updatedAt: status.observedAt
    });
    await this.store.save(next, record.recordHash);
    return { record: next, verificationEvidence: verificationFor(lineageRequest, next) };
  }

  private async pollAccepted(
    request: AuthorizedBusinessActionRequest,
    adapter: BusinessActionAdapter,
    initial: BusinessActionExecutionRecord
  ): Promise<BusinessActionExecutionResult> {
    if (!initial.providerOperationId) {
      throw new ControlPlaneError("CONFLICT", "Accepted business action is missing provider operation lineage");
    }
    let record = initial;
    const polls = this.options.maxStatusPolls ?? 30;
    const interval = this.options.pollIntervalMs ?? 1_000;
    const sleep = this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    for (let index = 0; index < polls; index += 1) {
      if (index > 0 && interval > 0) await sleep(interval);
      const status = await this.providerCall(
        request,
        adapter,
        "status",
        async () => adapter.status({
          requestId: request.id,
          providerOperationId: initial.providerOperationId!
        }, await this.credentialContext(request, adapter))
      );
      assertStatusIdentity(adapter, request, initial.providerOperationId, status);

      const previousHash = record.recordHash;
      record = createRecord({
        ...record,
        state: status.state,
        latestStatusHash: status.statusHash,
        updatedAt: status.observedAt
      });
      await this.store.save(record, previousHash);
      if (status.state === "pending" || status.state === "running") {
        await getTelemetry().gauge(
          "getdone.verification.pending.age",
          Math.max(0, Date.now() - Date.parse(initial.updatedAt)),
          "ms",
          {
            [OTEL_SEMANTIC.provider]: adapter.id,
            [OTEL_SEMANTIC.capability]: request.capability
          }
        );
      }
      if (["completed", "failed", "cancelled"].includes(status.state)) {
        return { record, verificationEvidence: verificationFor(request, record) };
      }
    }
    return { record };
  }
}
