import { describe, expect, it } from "vitest";
import { postgresTlsConnection } from "@/lib/persistence/postgres/tls";

describe("PostgreSQL TLS", () => {
  it("prevents URL SSL settings from replacing certificate verification", () => {
    const config = postgresTlsConnection("postgres://user:password@db.test/db?sslmode=require&uselibpqcompat=true&application_name=test", { GETDONE_RUNTIME_ENV: "production" });
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    expect(config.connectionString).not.toContain("sslmode");
    expect(config.connectionString).not.toContain("uselibpqcompat");
    expect(config.connectionString).toContain("application_name=test");
  });
  it("rejects unverified production transport and permits explicit local test transport", () => {
    expect(() => postgresTlsConnection("postgres://db.test/db?sslmode=disable", { GETDONE_RUNTIME_ENV: "production" })).toThrow(/TLS/);
    expect(() => postgresTlsConnection("postgres://db.test/db", { NODE_ENV: "production", GETDONE_DB_SSL: "false" })).toThrow(/TLS/);
    expect(postgresTlsConnection("postgres://localhost/db", { GETDONE_DB_SSL: "false" }).ssl).toBe(false);
  });
});
