import { describe, expect, it } from "vitest";
import { PostgresOwnerIntentStore } from "./control-api-stores";
import type { PostgresTransactionalDatabase } from "./client";
import type { OwnerIntentRecord } from "@/lib/control-api/contracts";

const turn = (id: string): OwnerIntentRecord => ({
  id, userId: "owner", portfolioId: "portfolio-a", companyId: "company-a",
  environment: "staging", message: id, channel: "chat",
  status: "accepted", receivedAt: "2026-10-14T00:00:00Z"
});

describe("Postgres persisted owner history read boundary", () => {
  it("filters by portfolio, company and user and restores chronological turns", async () => {
    let sql = "";
    let args: readonly unknown[] | undefined;
    const db = {
      query: async (statement: string, parameters: readonly unknown[]) => {
        sql = statement;
        args = parameters;
        return { rows: [{ payload: turn("newer") }, { payload: turn("older") }] };
      }
    } as unknown as PostgresTransactionalDatabase;
    const result = await new PostgresOwnerIntentStore(db).listByOwner("portfolio-a", "company-a", "owner");
    expect(args).toEqual(["portfolio-a", "company-a", "owner"]);
    expect(sql).toContain("portfolio_id=$1 AND company_id=$2 AND user_id=$3");
    expect(sql).toContain("LIMIT 100");
    expect(result.map(item => item.id)).toEqual(["older", "newer"]);
  });
});
