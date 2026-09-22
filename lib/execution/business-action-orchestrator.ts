import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  assertAuthorizedBusinessActionRequest,
  assertBusinessActionAdapterResult,
  assertBusinessActionStatus,
  type AuthorizedBusinessActionRequest,
  type BusinessActionAdapter,
  type BusinessActionStatus
} from "@/lib/execution/adapters/business-action";
import { createVerificationEvidence, type VerificationEvidence } from "@/lib/verification/verification";
import { validateCapabilityOutput } from "@/lib/domain/capabilities";

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
    } = {}
  ) {}

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
      if (["completed", "rejected", "failed", "cancelled"].includes(existing.state)) {
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

    const result = await adapter.execute(request);
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
      jobId: request.jobId,
      requestHash,
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      providerOperationId: result.providerOperationId,
      state: result.status === "accepted" ? "accepted" : result.status,
      adapterResultHash: result.resultHash,
      output: result.status === "completed"
        ? validateCapabilityOutput(request.capability, result.output)
        : undefined,
      outputHash: result.outputHash,
      retryable: result.retryable,
      updatedAt: result.observedAt
    });
    await this.store.save(record, existing?.recordHash);

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
    if (record.requestHash !== sha256Hex(request)) {
      throw new ControlPlaneError("IDEMPOTENCY_CONFLICT", "Cancellation request does not match persisted action");
    }
    const adapter = await this.adapters.resolve(request);
    if (!adapter?.cancel) {
      throw new ControlPlaneError("UNAVAILABLE", "Business action adapter does not support cancellation");
    }
    const status = await adapter.cancel({
      requestId: request.id,
      providerOperationId: record.providerOperationId,
      reason
    });
    assertStatusIdentity(adapter, request, record.providerOperationId, status);
    const next = createRecord({
      ...record,
      state: status.state,
      latestStatusHash: status.statusHash,
      updatedAt: status.observedAt
    });
    await this.store.save(next, record.recordHash);
    return { record: next, verificationEvidence: verificationFor(request, next) };
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
      const status = await adapter.status({
        requestId: request.id,
        providerOperationId: initial.providerOperationId
      });
      assertStatusIdentity(adapter, request, initial.providerOperationId, status);

      const previousHash = record.recordHash;
      record = createRecord({
        ...record,
        state: status.state,
        latestStatusHash: status.statusHash,
        updatedAt: status.observedAt
      });
      await this.store.save(record, previousHash);
      if (["completed", "failed", "cancelled"].includes(status.state)) {
        return { record, verificationEvidence: verificationFor(request, record) };
      }
    }
    return { record };
  }
}
