import { describe, expect, it } from "vitest";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  createAuthorizationConsumptionRecord
} from "@/lib/authorization/grants";
import type { GeneratedTask } from "@/lib/planning/task-generator";
import { autoGrantFor, fixtureNow } from "@/lib/planning/test-security-fixture";
import { validPlan } from "@/lib/planning/test-fixture";
import type {
  PostgresTransactionalDatabase,
  SqlQueryable
} from "@/lib/persistence/postgres/client";
import { PostgresTaskGenerationDedupeStore } from "@/lib/persistence/postgres/orchestration-task-dedupe-store";

interface FakeResponse {
  rows?: QueryResultRow[];
  rowCount?: number;
}

class QueueSql implements SqlQueryable {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  constructor(private readonly responses: FakeResponse[]) {}
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

function database(sql: QueueSql): PostgresTransactionalDatabase {
  return {
    query: sql.query.bind(sql),
    async transaction<T>(operation: (client: PoolClient) => Promise<T>) {
      return operation(sql as unknown as PoolClient);
    }
  };
}

function fixture() {
  const plan = validPlan();
  const grant = autoGrantFor(plan);
  const taskId = "task-1";
  const consumption = createAuthorizationConsumptionRecord({
    id: `authorization-consumption:${grant.id}`,
    grant,
    consumerType: "task",
    consumerId: taskId,
    consumedAt: fixtureNow.toISOString()
  });
  const task = {
    id: taskId,
    logicalKey: "logical-task-1",
    scope: {
      userId: "user-a",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "staging",
      dataClass: "internal"
    },
    authorizationGrantId: grant.id,
    authorizationGrantHash: grant.grantHash,
    authorizationConsumption: consumption,
    createdAt: fixtureNow.toISOString()
  } as GeneratedTask;
  return { grant, task, consumption };
}

describe("PostgresTaskGenerationDedupeStore", () => {
  it("atomically consumes persisted grant authority and claims one logical Task", async () => {
    const { grant, task, consumption } = fixture();
    const sql = new QueueSql([
      { rows: [] },
      { rows: [{ payload: grant }] },
      { rowCount: 1 },
      { rowCount: 1 }
    ]);
    const store = new PostgresTaskGenerationDedupeStore(database(sql));

    await expect(store.claim(task, consumption)).resolves.toMatchObject({
      created: true,
      task: { id: task.id },
      consumption: { consumptionHash: consumption.consumptionHash }
    });
    expect(sql.calls.some((call) =>
      call.text.includes("INSERT INTO authorization_consumptions")
    )).toBe(true);
    expect(sql.calls.some((call) =>
      call.text.includes("INSERT INTO orchestration_task_generation_claims")
    )).toBe(true);
  });

  it("returns exact logical Task replay without consuming the grant again", async () => {
    const { grant, task, consumption } = fixture();
    const sql = new QueueSql([{
      rows: [{
        task_id: task.id,
        logical_key: task.logicalKey,
        task_hash: "task-hash",
        grant_id: grant.id,
        consumption_hash: consumption.consumptionHash,
        task_payload: task,
        consumption_payload: consumption
      }]
    }]);
    const store = new PostgresTaskGenerationDedupeStore(database(sql));

    await expect(store.claim(task, consumption)).resolves.toMatchObject({
      created: false,
      task: { id: task.id }
    });
    expect(sql.calls).toHaveLength(1);
  });

  it("rejects logical-key replay with different authorization lineage", async () => {
    const { grant, task, consumption } = fixture();
    const sql = new QueueSql([{
      rows: [{
        task_id: "different-task",
        logical_key: task.logicalKey,
        task_hash: "other",
        grant_id: grant.id,
        consumption_hash: consumption.consumptionHash,
        task_payload: task,
        consumption_payload: consumption
      }]
    }]);
    const store = new PostgresTaskGenerationDedupeStore(database(sql));

    await expect(store.claim(task, consumption)).rejects.toThrow(/different authorization lineage/i);
  });
});
