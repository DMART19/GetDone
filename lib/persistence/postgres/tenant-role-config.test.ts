import { describe, expect, it } from "vitest";
import { readPostgresConfigFromEnv } from "@/lib/persistence/postgres/client";

const url = "postgresql://postgres:irrelevant@127.0.0.1:5432/local_test";

describe("authoritative PostgreSQL runtime role", () => {
  it.each(["staging", "production"])("fails closed without the tenant role in %s", envName => {
    expect(() => readPostgresConfigFromEnv({
      DATABASE_URL: url,
      GETDONE_RUNTIME_ENV: envName,
      GETDONE_DB_SSL: "true"
    })).toThrow(/GETDONE_DB_RUNTIME_ROLE=getdone_tenant_runtime/);

    expect(() => readPostgresConfigFromEnv({
      DATABASE_URL: url,
      GETDONE_RUNTIME_ENV: envName,
      GETDONE_DB_RUNTIME_ROLE: "postgres",
      GETDONE_DB_SSL: "true"
    })).toThrow(/GETDONE_DB_RUNTIME_ROLE=getdone_tenant_runtime/);

    expect(readPostgresConfigFromEnv({
      DATABASE_URL: url,
      GETDONE_RUNTIME_ENV: envName,
      GETDONE_DB_RUNTIME_ROLE: "getdone_tenant_runtime",
      GETDONE_DB_SSL: "true"
    }).runtimeRole).toBe("getdone_tenant_runtime");
  });

  it("preserves explicit local integration admin configuration outside authoritative runtime", () => {
    expect(readPostgresConfigFromEnv({
      DATABASE_URL: url,
      GETDONE_RUNTIME_ENV: "development",
      GETDONE_DB_SSL: "false"
    }).runtimeRole).toBeUndefined();
  });

  it("rejects unsafe role identifiers, even in development", () => {
    expect(() => readPostgresConfigFromEnv({
      DATABASE_URL: url,
      GETDONE_RUNTIME_ENV: "development",
      GETDONE_DB_RUNTIME_ROLE: "postgres; DROP TABLE auth_users"
    })).toThrow(/safe PostgreSQL role identifier/);
  });
});
