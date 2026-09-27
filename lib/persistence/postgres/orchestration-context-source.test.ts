import { describe, expect, it } from "vitest";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import type { OwnerIntentRecord } from "@/lib/control-api/contracts";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import type {
  PostgresTransactionalDatabase,
  SqlQueryable
} from "@/lib/persistence/postgres/client";
import { PostgresOwnerIntentContextSource } from "@/lib/persistence/postgres/orchestration-context-source";

class OneQuerySql implements SqlQueryable {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  constructor(private readonly row: QueryResultRow | null) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<R>> {
    this.calls.push({ text, values });
    return {
      command: "",
      rowCount: this.row ? 1 : 0,
      oid: 0,
      fields: [],
      rows: (this.row ? [this.row] : []) as R[]
    };
  }
}

function db(sql: OneQuerySql): PostgresTransactionalDatabase {
  return {
    query: sql.query.bind(sql),
    async transaction<T>(operation: (client: PoolClient) => Promise<T>) {
      return operation(sql as unknown as PoolClient);
    }
  };
}

function run(source: OrchestrationRun["source"] = { kind: "owner-intent", ownerIntentId: "intent-1" }): OrchestrationRun {
  return Object.freeze({
    id: "orchestration:owner-intent:intent-1",
    correlationId: "corr-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging",
    authorityUserId: "user-a",
    initiatingActor: Object.freeze({ type: "user" as const, id: "user-a" }),
    source,
    state: "context-building",
    attempt: 1,
    version: 2,
    availableAt: "2026-09-27T20:00:00.000Z",
    createdAt: "2026-09-27T20:00:00.000Z",
    updatedAt: "2026-09-27T20:00:00.000Z"
  });
}

function intent(overrides: Partial<OwnerIntentRecord> = {}): OwnerIntentRecord {
  return {
    id: "intent-1",
    correlationId: "corr-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging",
    userId: "user-a",
    message: "Inspect the repository.",
    channel: "chat",
    status: "accepted",
    receivedAt: "2026-09-27T19:59:00.000Z",
    ...overrides
  };
}

describe("PostgresOwnerIntentContextSource", () => {
  it("loads only the authoritative OwnerIntent and labels its configured sensitivity", async () => {
    const sql = new OneQuerySql({ payload: intent() });
    const source = new PostgresOwnerIntentContextSource(db(sql), {
      sensitivity: "internal"
    });

    const result = await source.load(run());
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("expected ready");
    expect(result.context.items).toEqual([
      expect.objectContaining({
        id: "owner-input:intent-1",
        sensitivity: "internal",
        content: "Inspect the repository."
      })
    ]);
    expect(sql.calls[0]?.values).toEqual(["intent-1", "portfolio-a", "company-a"]);
  });

  it("rejects a mismatched authoritative envelope", async () => {
    const sql = new OneQuerySql({ payload: intent({ userId: "other-user" }) });
    const source = new PostgresOwnerIntentContextSource(db(sql), {
      sensitivity: "sensitive"
    });

    await expect(source.load(run())).rejects.toThrow(/authority envelope/i);
  });

  it("defers non-owner sources until their trusted context adapter is connected", async () => {
    const sql = new OneQuerySql(null);
    const source = new PostgresOwnerIntentContextSource(db(sql), {
      sensitivity: "sensitive"
    });

    await expect(source.load(run({
      kind: "investigation",
      investigationId: "investigation-1",
      signalIds: ["signal-1"]
    }))).resolves.toMatchObject({
      kind: "unavailable",
      reason: "context-source-not-connected:investigation"
    });
    expect(sql.calls).toHaveLength(0);
  });
});
