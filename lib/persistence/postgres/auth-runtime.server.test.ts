import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GETDONE_AUTH_RUNTIME_ROLE,
  readAuthPostgresConfigFromEnv
} from "@/lib/persistence/postgres/auth-runtime.server";

const staging = {
  GETDONE_RUNTIME_ENV: "staging",
  GETDONE_DB_SSL: "true",
  DATABASE_URL: "postgresql://postgres.example:fixture@localhost:5432/test"
};

describe("separate server-only PostgreSQL auth/security connection", () => {
  it("always uses the restricted auth role rather than the tenant or login role", () => {
    const config = readAuthPostgresConfigFromEnv({
      ...staging,
      GETDONE_DB_RUNTIME_ROLE: "getdone_tenant_runtime"
    });
    expect(config.runtimeRole).toBe(GETDONE_AUTH_RUNTIME_ROLE);
    expect(config.runtimeRole).not.toBe("getdone_tenant_runtime");
    expect(config.maxConnections).toBe(3);
    expect(config.ssl).toBe(true);
  });

  it("fails closed when missing a verified server runtime or database URL", () => {
    expect(() => readAuthPostgresConfigFromEnv({
      ...staging,
      GETDONE_RUNTIME_ENV: "development"
    })).toThrow(/staging or production/);
    expect(() => readAuthPostgresConfigFromEnv({
      ...staging,
      GETDONE_RUNTIME_ENV: undefined
    })).toThrow(/staging or production/);
    expect(() => readAuthPostgresConfigFromEnv({
      ...staging,
      DATABASE_URL: undefined
    })).toThrow(/DATABASE_URL/);
  });

  it("limits the migration role to identity, membership, challenge and hashed request counters", () => {
    const migration = readFileSync("migrations/2026-10-17.1_auth_runtime_boundary.sql", "utf8");
    expect(migration).toContain("NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS");
    expect(migration).toContain("TO getdone_auth_runtime");
    expect(migration).toContain("rate_limit_buckets");
    expect(migration).toContain("CREATE POLICY getdone_server_auth_only");
    expect(migration).toContain("table_name NOT IN");
    expect(migration).not.toMatch(/GRANT\s+.+?\bON\s+authorization_grants\s+TO getdone_auth_runtime/i);
    expect(migration).not.toMatch(/GRANT\s+.+?\bON\s+control_plane_entities\s+TO getdone_auth_runtime/i);
    expect(migration).not.toContain("TO getdone_tenant_runtime");
  });
});
