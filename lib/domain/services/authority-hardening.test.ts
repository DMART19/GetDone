import { describe, expect, it } from "vitest";
import type { AuditEvent, AuditLedger } from "@/lib/domain/audit";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import type {
  IdempotencyClaim,
  IdempotencyRecord,
  IdempotencyStore
} from "@/lib/domain/idempotency";
import { MemoryIdempotencyStore } from "@/lib/domain/idempotency";
import type { AuthoritativeEntity, EntityStore } from "@/lib/domain/services/common";
import {
  PlanService,
  type PlanRecord,
  type PlanStores
} from "@/lib/domain/services/plan-service";
import {
  TaskService,
  type TaskRecord,
  type TaskStores
} from "@/lib/domain/services/task-service";
import {
  JobService,
  type JobRecord,
  type JobStores
} from "@/lib/domain/services/job-service";
import {
  assertAuthorizationConsumption,
  createAuthorizationConsumptionRecord,
  type AuthorizationConsumptionRecord,
  type AuthorizationGrant,
  type AuthorizationGrantStore
} from "@/lib/authorization/grants";
import { validPlan } from "@/lib/planning/test-fixture";
import {
  autoGrantFor,
  fixtureNow
} from "@/lib/planning/test-security-fixture";
import { hashPlan } from "@/lib/planning/plan-hash";

class MemoryStore<T extends AuthoritativeEntity> implements EntityStore<T> {
  constructor(public value: T) {}

  async get(id: string) {
    return id === this.value.id ? { ...this.value } : null;
  }

  async save(next: T, expectedVersion: number) {
    if (this.value.version !== expectedVersion) {
      throw new Error("optimistic concurrency conflict");
    }
    this.value = { ...next };
  }
}

class MemoryAudit implements AuditLedger {
  readonly events: AuditEvent[] = [];

  async append(event: AuditEvent) {
    this.events.push(event);
  }

  async listByCorrelationId(correlationId: string) {
    return this.events.filter((event) => event.correlationId === correlationId);
  }
}

class MutableGrantStore implements AuthorizationGrantStore {
  grant: AuthorizationGrant | null;
  readonly consumptions: AuthorizationConsumptionRecord[] = [];

  constructor(grant: AuthorizationGrant | null) {
    this.grant = grant;
  }

  async get(id: string) {
    return this.grant?.id === id ? this.grant : null;
  }

  async consume(record: AuthorizationConsumptionRecord) {
    if (!this.grant) throw new Error("authorization grant missing");
    assertAuthorizationConsumption(record, this.grant);
    const existing = this.consumptions.find((item) => item.grantId === record.grantId);
    if (existing) {
      if (existing.consumptionHash !== record.consumptionHash) {
        throw new Error("conflicting authorization consumption");
      }
      return;
    }
    this.consumptions.push(record);
  }

  async listConsumptions(grantId: string) {
    return this.consumptions.filter((record) => record.grantId === grantId);
  }

  async revoke(id: string, reason: string, revokedAt: string) {
    void reason;
    void revokedAt;
    if (this.grant?.id === id) {
      this.grant = { ...this.grant, status: "revoked" };
    }
  }
}

function manager<TStores>(
  stores: TStores,
  audit = new MemoryAudit()
): ControlPlaneTransactionManager<TStores> {
  const idempotency = new MemoryIdempotencyStore();
  return {
    run: async (operation) => operation({ stores, audit, idempotency })
  };
}

class TransactionalPlanManager implements ControlPlaneTransactionManager<PlanStores> {
  private current: PlanRecord;
  private auditEvents: AuditEvent[] = [];
  private idempotencyRecords = new Map<string, IdempotencyRecord>();
  failAudit = false;
  forceSaveConflict = false;

  constructor(
    initial: PlanRecord,
    private readonly grants: AuthorizationGrantStore
  ) {
    this.current = { ...initial };
  }

  plan() {
    return { ...this.current };
  }

  audit() {
    return [...this.auditEvents];
  }

  async run<T>(operation: Parameters<ControlPlaneTransactionManager<PlanStores>["run"]>[0]) {
    let staged = { ...this.current };
    const stagedAudit = [...this.auditEvents];
    const stagedIdempotency = new Map(this.idempotencyRecords);

    const plans: EntityStore<PlanRecord> = {
      get: async (id) => id === staged.id ? { ...staged } : null,
      save: async (next, expectedVersion) => {
        if (this.forceSaveConflict || staged.version !== expectedVersion) {
          throw new Error("optimistic concurrency conflict");
        }
        staged = { ...next };
      }
    };

    const audit: AuditLedger = {
      append: async (event) => {
        if (this.failAudit) throw new Error("simulated audit failure");
        stagedAudit.push(event);
      },
      listByCorrelationId: async (correlationId) =>
        stagedAudit.filter((event) => event.correlationId === correlationId)
    };

    const idempotency: IdempotencyStore = {
      async claim<R = unknown>(
        key: string,
        fingerprint: string,
        createdAt: string
      ): Promise<IdempotencyClaim<R>> {
        const existing = stagedIdempotency.get(key) as IdempotencyRecord<R> | undefined;
        if (existing) {
          if (existing.fingerprint !== fingerprint) {
            return { state: "CONFLICT", record: existing };
          }
          return { state: existing.status, record: existing };
        }
        const record: IdempotencyRecord<R> = {
          key,
          fingerprint,
          status: "IN_PROGRESS",
          createdAt
        };
        stagedIdempotency.set(key, record as IdempotencyRecord);
        return { state: "CREATED", record };
      },
      async complete<R = unknown>(
        key: string,
        fingerprint: string,
        result: R,
        completedAt: string
      ) {
        const existing = stagedIdempotency.get(key);
        if (!existing || existing.fingerprint !== fingerprint) {
          throw new Error("idempotency conflict");
        }
        const record: IdempotencyRecord<R> = {
          ...existing,
          status: "COMPLETED",
          completedAt,
          result
        };
        stagedIdempotency.set(key, record as IdempotencyRecord);
        return record;
      },
      async fail(key: string, fingerprint: string, errorCode: string, failedAt: string) {
        const existing = stagedIdempotency.get(key);
        if (!existing || existing.fingerprint !== fingerprint) {
          throw new Error("idempotency conflict");
        }
        const record: IdempotencyRecord = {
          ...existing,
          status: "FAILED",
          failedAt,
          errorCode
        };
        stagedIdempotency.set(key, record);
        return record;
      },
      async get<R = unknown>(key: string) {
        return (stagedIdempotency.get(key) as IdempotencyRecord<R> | undefined) ?? null;
      }
    };

    const result = await operation({
      stores: { plans, authorizationGrants: this.grants },
      audit,
      idempotency
    });

    this.current = staged;
    this.auditEvents = stagedAudit;
    this.idempotencyRecords = stagedIdempotency;
    return result as T;
  }
}

let commandCounter = 0;
function command(type: string, companyId = "company-a") {
  commandCounter += 1;
  return createCommandEnvelope({
    commandId: `authority-command-${commandCounter}`,
    actor: { type: "user", id: "user-a" },
    scope: {
      userId: "user-a",
      portfolioId: "portfolio-a",
      companyId,
      environment: "staging"
    },
    correlationId: `authority-correlation-${commandCounter}`,
    environment: "staging",
    idempotencyKey: `authority-idempotency-${commandCounter}`,
    provenance: "authority-hardening-test",
    requestedMutation: { type }
  });
}

function planFixture(grant: AuthorizationGrant, overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    id: grant.planId,
    portfolioId: grant.scope.portfolioId,
    companyId: grant.scope.companyId,
    state: "proposed",
    planVersion: grant.planVersion,
    planHash: grant.planHash,
    requestedCapabilities: [...grant.capabilityNames],
    validationErrors: [],
    version: 1,
    updatedAt: fixtureNow.toISOString(),
    ...overrides
  };
}

function taskFixture(grant: AuthorizationGrant, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-authority-1",
    portfolioId: grant.scope.portfolioId,
    companyId: grant.scope.companyId,
    state: "proposed",
    reason: "authorized work",
    evidenceIds: [],
    capabilityRequirements: [...grant.capabilityNames],
    authorizationLineage: [],
    verificationEvidenceIds: [],
    version: 1,
    updatedAt: fixtureNow.toISOString(),
    ...overrides
  };
}

function jobFixture(grant: AuthorizationGrant, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-authority-1",
    portfolioId: grant.scope.portfolioId,
    companyId: grant.scope.companyId,
    state: "created",
    taskId: "task-authority-1",
    attempt: 0,
    verificationEvidenceIds: [],
    version: 1,
    updatedAt: fixtureNow.toISOString(),
    ...overrides
  };
}

describe("MVP authority service hardening", () => {
  it("runs the authoritative Plan path and emits one audit event per committed transition", async () => {
    const plan = validPlan();
    const grant = autoGrantFor(plan);
    const grants = new MutableGrantStore(grant);
    const tx = new TransactionalPlanManager(planFixture(grant), grants);
    const service = new PlanService(tx, () => fixtureNow);

    await service.beginValidation(grant.planId, command("plan.validate"));
    await service.markValidated(grant.planId, command("plan.validated"), "validation-receipt-1");
    await service.requestAuthorization(grant.planId, command("plan.request-authorization"));
    const authorized = await service.authorize(grant.planId, command("plan.authorize"), grant);
    const compiled = await service.compile(grant.planId, command("plan.compile"), "compiled-graph-1");

    expect(authorized.authorizationGrantHash).toBe(grant.grantHash);
    expect(compiled.state).toBe("compiled");
    expect(compiled.version).toBe(6);
    expect(tx.audit().map((event) => event.eventType)).toEqual([
      "plan.validating",
      "plan.validated",
      "plan.awaiting-authorization",
      "plan.authorized",
      "plan.compiled"
    ]);
  });

  it("makes an identical command idempotent but rejects a second command that repeats the transition", async () => {
    const grant = autoGrantFor(validPlan());
    const tx = new TransactionalPlanManager(planFixture(grant), new MutableGrantStore(grant));
    const service = new PlanService(tx, () => fixtureNow);
    const sameCommand = command("plan.validate.idempotent");

    const first = await service.beginValidation(grant.planId, sameCommand);
    const replay = await service.beginValidation(grant.planId, sameCommand);

    expect(replay).toEqual(first);
    expect(tx.audit()).toHaveLength(1);
    await expect(
      service.beginValidation(grant.planId, command("plan.validate.duplicate"))
    ).rejects.toThrow(/invalid plan transition/i);
  });

  it("rolls back entity, audit, and idempotency on transaction failure and allows a clean retry", async () => {
    const grant = autoGrantFor(validPlan());
    const tx = new TransactionalPlanManager(planFixture(grant), new MutableGrantStore(grant));
    const service = new PlanService(tx, () => fixtureNow);
    const retryable = command("plan.validate.retry");

    tx.failAudit = true;
    await expect(service.beginValidation(grant.planId, retryable)).rejects.toThrow(/audit failure/i);
    expect(tx.plan().state).toBe("proposed");
    expect(tx.plan().version).toBe(1);
    expect(tx.audit()).toHaveLength(0);

    tx.failAudit = false;
    const retried = await service.beginValidation(grant.planId, retryable);
    expect(retried.state).toBe("validating");
    expect(retried.version).toBe(2);
    expect(tx.audit()).toHaveLength(1);
  });

  it("fails a stale compare-and-swap update without emitting audit and can retry after the conflict clears", async () => {
    const grant = autoGrantFor(validPlan());
    const tx = new TransactionalPlanManager(planFixture(grant), new MutableGrantStore(grant));
    const service = new PlanService(tx, () => fixtureNow);
    const retryable = command("plan.validate.concurrent");

    tx.forceSaveConflict = true;
    await expect(service.beginValidation(grant.planId, retryable)).rejects.toThrow(/concurrency conflict/i);
    expect(tx.plan().state).toBe("proposed");
    expect(tx.audit()).toHaveLength(0);

    tx.forceSaveConflict = false;
    expect((await service.beginValidation(grant.planId, retryable)).state).toBe("validating");
  });

  it("rejects cross-company Plan commands before authority state changes", async () => {
    const grant = autoGrantFor(validPlan());
    const tx = new TransactionalPlanManager(planFixture(grant), new MutableGrantStore(grant));
    const service = new PlanService(tx, () => fixtureNow);

    await expect(
      service.beginValidation(grant.planId, command("plan.cross-company", "company-b"))
    ).rejects.toThrow(/outside the trusted command scope/i);
    expect(tx.plan().state).toBe("proposed");
  });

  it("binds Plan authorization to the current version, hash, capabilities, and persisted grant", async () => {
    const grant = autoGrantFor(validPlan());
    const cases: Array<{ name: string; overrides: Partial<PlanRecord> }> = [
      { name: "version", overrides: { planVersion: grant.planVersion + 1 } },
      { name: "hash", overrides: { planHash: hashPlan({ ...validPlan(), proposalVersion: validPlan().proposalVersion + 1 }) } },
      { name: "capabilities", overrides: { requestedCapabilities: [...grant.capabilityNames, "extra.capability"] } }
    ];

    for (const testCase of cases) {
      const tx = new TransactionalPlanManager(
        planFixture(grant, { state: "awaiting-authorization", ...testCase.overrides }),
        new MutableGrantStore(grant)
      );
      const service = new PlanService(tx, () => fixtureNow);
      await expect(
        service.authorize(grant.planId, command(`plan.authorize.bad-${testCase.name}`), grant)
      ).rejects.toThrow(/version, hash, or capabilities/i);
      expect(tx.plan().state).toBe("awaiting-authorization");
    }

    const missing = new TransactionalPlanManager(
      planFixture(grant, { state: "awaiting-authorization" }),
      new MutableGrantStore(null)
    );
    await expect(
      new PlanService(missing, () => fixtureNow)
        .authorize(grant.planId, command("plan.authorize.missing"), grant)
    ).rejects.toThrow(/missing or differs/i);
  });

  it("rejects revoked or expired authorization before a Plan can become authorized", async () => {
    const grant = autoGrantFor(validPlan());
    const revokedStore = new MutableGrantStore(grant);
    await revokedStore.revoke(grant.id, "owner revoked", fixtureNow.toISOString());
    const revokedTx = new TransactionalPlanManager(
      planFixture(grant, { state: "awaiting-authorization" }),
      revokedStore
    );
    await expect(
      new PlanService(revokedTx, () => fixtureNow)
        .authorize(grant.planId, command("plan.authorize.revoked"), grant)
    ).rejects.toThrow();

    const expiredTx = new TransactionalPlanManager(
      planFixture(grant, { state: "awaiting-authorization" }),
      new MutableGrantStore(grant)
    );
    expect(() =>
      new PlanService(expiredTx, () => new Date(Date.parse(grant.expiresAt) + 1))
        .authorize(grant.planId, command("plan.authorize.expired"), grant)
    ).toThrow(/not currently valid/i);
  });

  it("requires exact Task capabilities and authoritative active grant storage before consumption", async () => {
    const grant = autoGrantFor(validPlan());

    const mismatchStore = new MemoryStore<TaskRecord>(
      taskFixture(grant, { capabilityRequirements: [...grant.capabilityNames, "extra.capability"] })
    );
    await expect(
      new TaskService(manager<TaskStores>({
        tasks: mismatchStore,
        authorizationGrants: new MutableGrantStore(grant)
      })).authorize(mismatchStore.value.id, command("task.authorize.capability-mismatch"), grant, fixtureNow.toISOString())
    ).rejects.toThrow(/capabilities do not match/i);

    const revoked = new MutableGrantStore(grant);
    await revoked.revoke(grant.id, "owner revoked", fixtureNow.toISOString());
    const revokedTask = new MemoryStore<TaskRecord>(taskFixture(grant));
    await expect(
      new TaskService(manager<TaskStores>({
        tasks: revokedTask,
        authorizationGrants: revoked
      })).authorize(revokedTask.value.id, command("task.authorize.revoked"), grant, fixtureNow.toISOString())
    ).rejects.toThrow();

    const expiredTask = new MemoryStore<TaskRecord>(taskFixture(grant));
    expect(() =>
      new TaskService(manager<TaskStores>({
        tasks: expiredTask,
        authorizationGrants: new MutableGrantStore(grant)
      })).authorize(
        expiredTask.value.id,
        command("task.authorize.expired"),
        grant,
        new Date(Date.parse(grant.expiresAt) + 1).toISOString()
      )
    ).toThrow(/not currently valid/i);
  });

  it("does not queue a Task that lacks persisted authorization consumption", async () => {
    const grant = autoGrantFor(validPlan());
    const store = new MemoryStore<TaskRecord>(
      taskFixture(grant, { state: "authorized" })
    );
    const service = new TaskService(manager<TaskStores>({ tasks: store }));

    await expect(
      service.queue(store.value.id, command("task.queue.no-consumption"))
    ).rejects.toThrow(/persisted authorization consumption/i);
    expect(store.value.state).toBe("authorized");
  });

  it("prevents a Job from inheriting forged or non-authoritative Task consumption", async () => {
    const grant = autoGrantFor(validPlan());
    const grants = new MutableGrantStore(grant);
    const store = new MemoryStore<JobRecord>(jobFixture(grant));
    const service = new JobService(manager<JobStores>({
      jobs: store,
      authorizationGrants: grants
    }));

    const forged = createAuthorizationConsumptionRecord({
      id: `authorization-consumption:${grant.id}`,
      grant,
      consumerType: "task",
      consumerId: store.value.taskId,
      consumedAt: fixtureNow.toISOString()
    });

    await expect(
      service.queue(
        store.value.id,
        command("job.queue.unpersisted-consumption"),
        grant,
        forged,
        fixtureNow.toISOString()
      )
    ).rejects.toThrow(/not authoritative/i);
    expect(store.value.state).toBe("created");

    await grants.consume(forged);
    const queued = await service.queue(
      store.value.id,
      command("job.queue.authoritative"),
      grant,
      forged,
      fixtureNow.toISOString()
    );
    expect(queued.state).toBe("queued");
    expect(queued.authorizationConsumption?.consumptionHash).toBe(forged.consumptionHash);
  });

  it("writes audit evidence for successful Task and Job authority transitions", async () => {
    const grant = autoGrantFor(validPlan());
    const grants = new MutableGrantStore(grant);
    const taskAudit = new MemoryAudit();
    const taskStore = new MemoryStore<TaskRecord>(taskFixture(grant));
    const taskService = new TaskService(manager<TaskStores>({
      tasks: taskStore,
      authorizationGrants: grants
    }, taskAudit));

    const authorized = await taskService.authorize(
      taskStore.value.id,
      command("task.authorize.audit"),
      grant,
      fixtureNow.toISOString()
    );
    await taskService.queue(taskStore.value.id, command("task.queue.audit"));

    const jobAudit = new MemoryAudit();
    const jobStore = new MemoryStore<JobRecord>(jobFixture(grant));
    const jobService = new JobService(manager<JobStores>({
      jobs: jobStore,
      authorizationGrants: grants
    }, jobAudit));
    await jobService.queue(
      jobStore.value.id,
      command("job.queue.audit"),
      grant,
      authorized.authorizationConsumption!,
      fixtureNow.toISOString()
    );

    expect(taskAudit.events.map((event) => event.eventType)).toEqual([
      "task.authorized",
      "task.queued"
    ]);
    expect(jobAudit.events.map((event) => event.eventType)).toEqual([
      "job.queued"
    ]);
  });
});
