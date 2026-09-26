import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { OutcomeRecord } from "@/lib/domain/services/outcome-service";
import {
  InvestigationCoordinator,
  type InvestigationCreationPolicy,
  type InvestigationResult
} from "@/lib/intelligence/investigations";
import type { SensedSignal, TrustedSignalScope } from "@/lib/intelligence/signals";

export const OUTCOME_RECONCILIATION_VERSION = "1.0.0";

export interface ConsequentialOutcomeSnapshot {
  outcomeId: string;
  outcomeState: "verified";
  portfolioId: string;
  companyId: string;
  jobId?: string;
  metric: string;
  value: number | string | boolean;
  verificationReceiptId: string;
  verificationReceiptHash: string;
  expectedExternalStateHash: string;
  recordedAt: string;
  snapshotHash: string;
}

export interface OutcomeReconciliationJob {
  id: string;
  snapshot: ConsequentialOutcomeSnapshot;
  actionKind: string;
  externalSubject: string;
  intervalSeconds: number;
  nextCheckAt: string;
  active: boolean;
  version: number;
}

export interface OutcomeReconciliationObservation {
  observedAt: string;
  externalStateHash: string;
  evidenceIds: readonly string[];
  provenance: string;
}

export interface OutcomeReconciliationProbe {
  observe(job: OutcomeReconciliationJob): Promise<OutcomeReconciliationObservation>;
}

export interface OutcomeReconciliationStore {
  listDue(now: string, limit: number): Promise<readonly OutcomeReconciliationJob[]>;
  recordCheck(input: {
    jobId: string;
    expectedVersion: number;
    checkedAt: string;
    nextCheckAt: string;
    result: "consistent" | "discrepant" | "failed";
    observedStateHash?: string;
    signalId?: string;
    investigationId?: string;
    errorCode?: string;
  }): Promise<void>;
}

export interface OutcomeReconciliationSignalSink {
  append(signal: SensedSignal): Promise<void>;
}

export interface OutcomeReconciliationDependencies {
  store: OutcomeReconciliationStore;
  probe: OutcomeReconciliationProbe;
  signals: OutcomeReconciliationSignalSink;
  investigations: InvestigationCoordinator;
  investigationPolicy: InvestigationCreationPolicy;
  now?: () => Date;
  idFactory?: () => string;
}

export interface OutcomeReconciliationResult {
  jobId: string;
  result: "consistent" | "discrepant" | "failed";
  signal?: SensedSignal;
  investigation?: InvestigationResult;
  errorCode?: string;
}

function parseTimestamp(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return parsed;
}

function trustedScope(snapshot: ConsequentialOutcomeSnapshot): TrustedSignalScope {
  return {
    portfolioId: snapshot.portfolioId,
    companyId: snapshot.companyId
  };
}

export function createConsequentialOutcomeSnapshot(input: {
  outcome: OutcomeRecord;
  expectedExternalStateHash: string;
  recordedAt: string;
}): ConsequentialOutcomeSnapshot {
  const { outcome } = input;
  if (outcome.state !== "verified") {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Only verified completed Outcomes can be registered for reconciliation"
    );
  }
  if (!outcome.verificationReceiptId || !outcome.verificationReceiptHash) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Outcome reconciliation requires the original verification receipt lineage"
    );
  }
  if (!input.expectedExternalStateHash) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Outcome reconciliation requires the original expected external-state hash"
    );
  }
  const recordedAt = new Date(parseTimestamp(input.recordedAt, "reconciliation recordedAt")).toISOString();
  const base = {
    outcomeId: outcome.id,
    outcomeState: "verified" as const,
    portfolioId: outcome.portfolioId,
    companyId: outcome.companyId,
    jobId: outcome.jobId,
    metric: outcome.metric,
    value: outcome.value,
    verificationReceiptId: outcome.verificationReceiptId,
    verificationReceiptHash: outcome.verificationReceiptHash,
    expectedExternalStateHash: input.expectedExternalStateHash,
    recordedAt
  };
  return Object.freeze({ ...base, snapshotHash: sha256Hex(base) });
}

export function createOutcomeReconciliationJob(input: {
  id: string;
  snapshot: ConsequentialOutcomeSnapshot;
  actionKind: string;
  externalSubject: string;
  intervalSeconds: number;
  firstCheckAt: string;
}): OutcomeReconciliationJob {
  if (!input.id || !input.actionKind || !input.externalSubject) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Outcome reconciliation job requires id, action kind, and external subject"
    );
  }
  if (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds < 60) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Outcome reconciliation interval must be at least 60 seconds"
    );
  }
  const firstCheckAt = new Date(parseTimestamp(input.firstCheckAt, "reconciliation firstCheckAt")).toISOString();
  return Object.freeze({
    id: input.id,
    snapshot: input.snapshot,
    actionKind: input.actionKind,
    externalSubject: input.externalSubject,
    intervalSeconds: input.intervalSeconds,
    nextCheckAt: firstCheckAt,
    active: true,
    version: 1
  });
}

export class OutcomeReconciliationService {
  constructor(private readonly dependencies: OutcomeReconciliationDependencies) {}

  async runDue(limit = 50): Promise<readonly OutcomeReconciliationResult[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Reconciliation batch limit must be 1..500");
    }
    const now = (this.dependencies.now ?? (() => new Date()))();
    const nowIso = now.toISOString();
    const due = await this.dependencies.store.listDue(nowIso, limit);
    const results: OutcomeReconciliationResult[] = [];

    for (const job of due) {
      if (!job.active || Date.parse(job.nextCheckAt) > now.getTime()) continue;
      results.push(await this.runOne(job, now));
    }

    return Object.freeze(results);
  }

  private async runOne(
    job: OutcomeReconciliationJob,
    now: Date
  ): Promise<OutcomeReconciliationResult> {
    const checkedAt = now.toISOString();
    const nextCheckAt = new Date(
      now.getTime() + job.intervalSeconds * 1000
    ).toISOString();

    try {
      const observation = await this.dependencies.probe.observe(job);
      parseTimestamp(observation.observedAt, "reconciliation observation observedAt");
      if (!observation.externalStateHash || !observation.provenance) {
        throw new ControlPlaneError(
          "VALIDATION_FAILED",
          "Reconciliation observation requires state hash and provenance"
        );
      }

      if (observation.externalStateHash === job.snapshot.expectedExternalStateHash) {
        await this.dependencies.store.recordCheck({
          jobId: job.id,
          expectedVersion: job.version,
          checkedAt,
          nextCheckAt,
          result: "consistent",
          observedStateHash: observation.externalStateHash
        });
        return { jobId: job.id, result: "consistent" };
      }

      const signal = this.discrepancySignal(job, observation, checkedAt);
      await this.dependencies.signals.append(signal);
      const investigation = await this.dependencies.investigations.consider(
        signal,
        this.dependencies.investigationPolicy,
        now
      );
      const investigationId =
        investigation.status === "created"
        || investigation.status === "updated"
        || investigation.status === "cooldown-suppressed"
          ? investigation.investigation.id
          : undefined;

      await this.dependencies.store.recordCheck({
        jobId: job.id,
        expectedVersion: job.version,
        checkedAt,
        nextCheckAt,
        result: "discrepant",
        observedStateHash: observation.externalStateHash,
        signalId: signal.id,
        investigationId
      });

      return { jobId: job.id, result: "discrepant", signal, investigation };
    } catch (error) {
      const errorCode = error instanceof ControlPlaneError ? error.code : "UNEXPECTED";
      await this.dependencies.store.recordCheck({
        jobId: job.id,
        expectedVersion: job.version,
        checkedAt,
        nextCheckAt,
        result: "failed",
        errorCode
      });
      return { jobId: job.id, result: "failed", errorCode };
    }
  }

  private discrepancySignal(
    job: OutcomeReconciliationJob,
    observation: OutcomeReconciliationObservation,
    receivedAt: string
  ): SensedSignal {
    const id = (this.dependencies.idFactory ?? (() => crypto.randomUUID()))();
    const scope = trustedScope(job.snapshot);
    const eventId = `outcome-reconciliation:${job.id}:${observation.externalStateHash}`;
    return Object.freeze({
      id,
      dedupeKey: [
        "outcome-reconciliation",
        scope.portfolioId,
        scope.companyId,
        job.snapshot.outcomeId,
        observation.externalStateHash
      ].join(":"),
      sourceBindingId: "getdone:outcome-reconciliation",
      eventId,
      streamKey: `outcome:${job.snapshot.outcomeId}`,
      type: "outcome.external-state-drift",
      occurredAt: observation.observedAt,
      receivedAt,
      scope,
      severity: "high",
      expected: false,
      attributes: Object.freeze({
        reconciliationJobId: job.id,
        outcomeId: job.snapshot.outcomeId,
        actionKind: job.actionKind,
        externalSubject: job.externalSubject,
        originalSnapshotHash: job.snapshot.snapshotHash,
        expectedExternalStateHash: job.snapshot.expectedExternalStateHash,
        observedExternalStateHash: observation.externalStateHash,
        evidenceCount: observation.evidenceIds.length
      }),
      provenance: observation.provenance,
      outOfOrder: false,
      classification: "risk",
      action: "INVESTIGATE",
      rationale: Object.freeze([
        "A consequential completed action no longer matches independently observed external state",
        "Historical Outcome truth remains unchanged; discrepancy is recorded as new operational evidence"
      ])
    });
  }
}
