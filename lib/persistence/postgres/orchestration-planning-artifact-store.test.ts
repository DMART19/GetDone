import { describe, expect, it } from "vitest";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { assembleContext } from "@/lib/intelligence/context";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import {
  createContextSnapshot,
  type OrchestrationPlanningArtifact
} from "@/lib/orchestration/planning-artifacts";
import type {
  PostgresTransactionalDatabase,
  SqlQueryable
} from "@/lib/persistence/postgres/client";
import { PostgresOrchestrationPlanningArtifactStore } from "@/lib/persistence/postgres/orchestration-planning-artifact-store";

interface FakeResponse {
  rows?: QueryResultRow[];
  rowCount?: number;
}

class QueueSql implements SqlQueryable {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  constructor(private readonly responses: FakeResponse[] = []) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<R>> {
    this.calls.push({ text, values });
    const response = this.responses.shift() ?? { rows: [], rowCount: 1 };
    return {
      command: "",
      rowCount: response.rowCount ?? response.rows?.length ?? 0,
      oid: 0,
      fields: [],
      rows: (response.rows ?? []) as R[]
    };
  }
}

function db(sql: QueueSql): PostgresTransactionalDatabase {
  return {
    query: sql.query.bind(sql),
    async transaction<T>(operation: (client: PoolClient) => Promise<T>) {
      return operation(sql as unknown as PoolClient);
    }
  };
}

function run(): OrchestrationRun {
  return Object.freeze({
    id: "orchestration:owner-intent:intent-1",
    correlationId: "corr-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging",
    authorityUserId: "user-a",
    initiatingActor: Object.freeze({ type: "user" as const, id: "user-a" }),
    source: Object.freeze({ kind: "owner-intent" as const, ownerIntentId: "intent-1" }),
    state: "context-building",
    attempt: 1,
    version: 2,
    availableAt: "2026-09-27T20:00:00.000Z",
    createdAt: "2026-09-27T20:00:00.000Z",
    updatedAt: "2026-09-27T20:00:00.000Z"
  });
}

function contextArtifact(): OrchestrationPlanningArtifact {
  const assembled = assembleContext([{
    id: "owner-input:intent-1",
    kind: "fact",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    source: "owner-intent",
    provenance: "owner-intent:intent-1",
    observedAt: "2026-09-27T19:59:00.000Z",
    freshnessSeconds: 3600,
    sensitivity: "internal",
    content: "Inspect the repository."
  }], {
    portfolioId: "portfolio-a",
    companyId: "company-a",
    allowedSensitivity: ["internal"]
  }, { now: Date.parse("2026-09-27T20:00:00.000Z") });

  return Object.freeze({
    kind: "context-snapshot" as const,
    value: createContextSnapshot({
      id: "context-1",
      runId: run().id,
      correlationId: "corr-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "staging",
      dataClass: "internal",
      assembled,
      createdAt: "2026-09-27T20:00:00.000Z"
    })
  });
}

function row(artifact = contextArtifact()) {
  return {
    id: artifact.value.id,
    run_id: artifact.value.runId,
    correlation_id: artifact.value.correlationId,
    portfolio_id: "portfolio-a",
    company_id: "company-a",
    artifact_kind: artifact.kind,
    artifact_hash: artifact.kind === "context-snapshot"
      ? artifact.value.contextHash
      : "",
    predecessor_hash: "corr-1",
    created_at: "2026-09-27T20:00:00.000Z",
    payload: artifact
  };
}

describe("PostgresOrchestrationPlanningArtifactStore", () => {
  it("appends immutable planning evidence and audits creation", async () => {
    const artifact = contextArtifact();
    const sql = new QueueSql([
      { rows: [row(artifact)], rowCount: 1 },
      { rows: [{ chain_sequence: 1, event_hash: "a".repeat(64) }], rowCount: 1 }
    ]);
    const store = new PostgresOrchestrationPlanningArtifactStore(db(sql));

    await expect(store.append(run(), artifact)).resolves.toEqual({ created: true });
    expect(sql.calls[0]?.text).toContain("INSERT INTO orchestration_planning_artifacts");
    expect(sql.calls[1]?.text).toContain("getdone_append_audit_event");
  });

  it("treats an exact replay as idempotent", async () => {
    const artifact = contextArtifact();
    const sql = new QueueSql([
      { rows: [], rowCount: 0 },
      { rows: [row(artifact)], rowCount: 1 }
    ]);
    const store = new PostgresOrchestrationPlanningArtifactStore(db(sql));

    await expect(store.append(run(), artifact)).resolves.toEqual({ created: false });
  });

  it("loads and verifies the latest artifact under run scope", async () => {
    const artifact = contextArtifact();
    const sql = new QueueSql([{ rows: [row(artifact)], rowCount: 1 }]);
    const store = new PostgresOrchestrationPlanningArtifactStore(db(sql));

    await expect(store.latestContext(run())).resolves.toEqual(artifact.value);
    expect(sql.calls[0]?.text).toContain("ORDER BY created_at DESC");
  });

  it("rejects artifact scope drift before touching persistence", async () => {
    const artifact = contextArtifact();
    const bad: OrchestrationPlanningArtifact = {
      kind: "context-snapshot",
      value: {
        ...artifact.value,
        companyId: "company-b"
      }
    };
    const sql = new QueueSql();
    const store = new PostgresOrchestrationPlanningArtifactStore(db(sql));

    await expect(store.append(run(), bad)).rejects.toThrow(/integrity|scope does not match/i);
    expect(sql.calls).toHaveLength(0);
  });
});
