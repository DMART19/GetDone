import { describe, expect, it, vi } from "vitest";
import { listBusinesses, readBusinessContext, withBusinessActivity } from "./repository";
import { getPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";

describe("business read boundaries", () => {
  it("requires all three active memberships and consistent company organization", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "company-a", portfolio_id: "portfolio-a", name: "A" }] });
    expect(await listBusinesses({ query } as SqlQueryable, "owner-a")).toEqual([{ id: "company-a", portfolioId: "portfolio-a", name: "A" }]);
    const [sql, values] = query.mock.calls[0];
    expect(values).toEqual(["owner-a"]);
    for (const condition of ["pm.status='active'", "om.status='active'", "cm.status='active'", "c.organization_id=p.organization_id"]) expect(sql).toContain(condition);
  });
  it("rejects a foreign portfolio before reading tenant records", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(readBusinessContext({ query } as SqlQueryable, "owner-a", "foreign", "staging")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("sets RLS scope, filters environment and emits only presentation fields", async () => {
    const query = vi.fn().mockImplementation(async (sql, values) => {
      if (sql.includes("portfolio_memberships")) return { rows: [{ id: "company-a", portfolio_id: "portfolio-a", name: "A" }] };
      expect(getPostgresTenantScope()).toEqual({ portfolioId: "portfolio-a", companyId: "company-a" });
      expect(values.slice(0, 2)).toEqual(["portfolio-a", "company-a"]);
      expect(values[3]).toBe("staging");
      expect(sql).toContain("payload->>'environment'=$4");
      expect(sql).toContain("LIMIT 20");
      return { rows: [{ id: "record", title: "Work", status: "queued", updated_at: new Date("2026-10-11T00:00:00Z"), credentialBindingId: "private" }] };
    });
    const result = await readBusinessContext({ query } as SqlQueryable, "owner-a", "portfolio-a", "staging");
    expect(result.sections.objectives.records[0]).toEqual({ id: "record", title: "Work", status: "queued", updatedAt: "2026-10-11T00:00:00.000Z" });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result.sections.signals.note).toContain("not connected");
    expect(getPostgresTenantScope()).toBeNull();
  });
});

describe("business activity timestamp normalization", () => {
  it.each([
    [new Date("2026-10-11T00:00:00Z"), "2026-10-11T00:00:00.000Z"],
    ["2026-10-11T00:00:00+00:00", "2026-10-11T00:00:00+00:00"],
    [null, undefined],
    [undefined, undefined]
  ])("normalizes %s without inventing missing activity", async (value, expected) => {
    const business = { id: "company-a", portfolioId: "portfolio-a", name: "A" };
    const query = vi.fn().mockImplementation(async (_sql, values) => {
      expect(getPostgresTenantScope()).toEqual({ portfolioId: "portfolio-a", companyId: "company-a" });
      expect(values).toEqual(["portfolio-a", "company-a", "staging"]);
      return { rows: value === undefined ? [] : [{ last_activity_at: value }] };
    });
    const [result] = await withBusinessActivity({ query } as SqlQueryable, [business], "staging");
    expect(result).toEqual({ ...business, ...(expected === undefined ? {} : { lastActivityAt: expected }) });
    expect(getPostgresTenantScope()).toBeNull();
  });
});
