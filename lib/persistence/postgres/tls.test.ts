import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { postgresTlsConnection } from "@/lib/persistence/postgres/tls";

describe("PostgreSQL TLS", () => {
  it.each(["sslmode=require", "sslmode=verify-ca", "ssl=false", "sslrootcert=/untrusted/ca&sslkey=/private/key&sslcert=/private/cert", "sslmode=require&uselibpqcompat=true"])("retains verification after pg parses hostile URL settings: %s", parameters => {
    const client = new Client(postgresTlsConnection(`postgres://db.test/db?${parameters}`, { GETDONE_RUNTIME_ENV: "production" }));
    expect(client.ssl).toEqual({ rejectUnauthorized: true });
  });
  it("prevents URL SSL settings from replacing certificate verification", () => {
    const config = postgresTlsConnection("postgres://user:password@db.test/db?sslmode=require&uselibpqcompat=true&application_name=test", { GETDONE_RUNTIME_ENV: "production" });
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    expect(config.connectionString).not.toContain("sslmode");
    expect(config.connectionString).not.toContain("uselibpqcompat");
    expect(config.connectionString).toContain("application_name=test");
  });
  it("fails closed on staging TLS opt-outs even when NODE_ENV is not production", () => {
    const staging = { GETDONE_RUNTIME_ENV: "staging", NODE_ENV: "test" } as const;
    expect(() => postgresTlsConnection("postgres://db.test/db?sslmode=disable", staging)).toThrow(/certificate-verified TLS/);
    expect(() => postgresTlsConnection("postgres://db.test/db?sslmode=no-verify", staging)).toThrow(/certificate-verified TLS/);
    expect(() => postgresTlsConnection("postgres://db.test/db", { ...staging, GETDONE_DB_SSL: "false" })).toThrow(/certificate-verified TLS/);
    expect(() => postgresTlsConnection("", { ...staging, GETDONE_DB_SSL: "false" })).toThrow();
    expect(new Client(postgresTlsConnection("postgres://db.test/db?sslmode=require", staging)).ssl).toEqual({ rejectUnauthorized: true });
  });
  it("rejects unverified production transport and permits explicit local test transport", () => {
    expect(() => postgresTlsConnection("postgres://db.test/db?sslmode=disable", { GETDONE_RUNTIME_ENV: "production" })).toThrow(/TLS/);
    expect(() => postgresTlsConnection("postgres://db.test/db", { NODE_ENV: "production", GETDONE_DB_SSL: "false" })).toThrow(/TLS/);
    expect(postgresTlsConnection("postgres://localhost/db", { GETDONE_DB_SSL: "false" }).ssl).toBe(false);
  });
});

describe("PostgreSQL TLS trust anchor (PGSSLROOTCERT)", () => {
  // Structurally valid PEM markers with a placeholder body. The module only passes the PEM through to
  // Node's TLS layer; it is not a real certificate and grants no trust to anything.
  const pem = "-----BEGIN CERTIFICATE-----\nVEVTVC1PTkxZLU5PVC1BLVJFQUwtQ0VSVElGSUNBVEU=\n-----END CERTIFICATE-----\n";
  const url = "postgres://user:s3cret-pass@db.test/db";
  const production = { GETDONE_RUNTIME_ENV: "production" } as const;
  let directory: string;
  let caFile: string;
  let notACertificate: string;

  beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), "getdone-tls-"));
    caFile = path.join(directory, "ca.crt");
    notACertificate = path.join(directory, "empty.crt");
    writeFileSync(caFile, pem);
    writeFileSync(notACertificate, "this is not a certificate\n");
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it("passes the configured CA to the pg client as ssl.ca and keeps verification enabled", () => {
    const config = postgresTlsConnection(url, { ...production, PGSSLROOTCERT: caFile, PGSSLMODE: "verify-full" });
    expect(config.ssl).toEqual({ rejectUnauthorized: true, ca: pem });
    expect(new Client(config).ssl).toEqual({ rejectUnauthorized: true, ca: pem });
  });
  it("never disables verification when a CA is configured", () => {
    const config = postgresTlsConnection(url, { ...production, PGSSLROOTCERT: caFile });
    expect(config.ssl).not.toBe(false);
    expect((config.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized).toBe(true);
  });
  it("takes the trust anchor only from the environment, not from URL parameters", () => {
    const config = postgresTlsConnection(`${url}?sslmode=verify-full&sslrootcert=/attacker/ca.crt&application_name=test`, { ...production, PGSSLROOTCERT: caFile });
    expect(config.ssl).toEqual({ rejectUnauthorized: true, ca: pem });
    expect(config.connectionString).not.toContain("sslrootcert");
    expect(config.connectionString).not.toContain("sslmode");
    expect(config.connectionString).toContain("application_name=test");
  });
  it("applies the CA to the environment-default connection outside production", () => {
    expect(postgresTlsConnection("", { PGSSLROOTCERT: caFile }).ssl).toEqual({ rejectUnauthorized: true, ca: pem });
  });
  it("adds no CA when PGSSLROOTCERT is unset or blank", () => {
    expect(postgresTlsConnection(url, production).ssl).toEqual({ rejectUnauthorized: true });
    expect(postgresTlsConnection(url, { ...production, PGSSLROOTCERT: "   " }).ssl).toEqual({ rejectUnauthorized: true });
    expect("ca" in (postgresTlsConnection(url, production).ssl as object)).toBe(false);
  });
  it.each([
    { label: "a missing file", resolve: () => path.join(directory, "missing.crt") },
    { label: "a directory", resolve: () => directory },
    { label: "a file without a PEM certificate", resolve: () => notACertificate }
  ])("fails closed in production when PGSSLROOTCERT is $label", ({ resolve }) => {
    expect(() => postgresTlsConnection(url, { ...production, PGSSLROOTCERT: resolve() })).toThrow(/PGSSLROOTCERT/);
    expect(() => postgresTlsConnection(url, { NODE_ENV: "production", PGSSLROOTCERT: resolve() })).toThrow(/PGSSLROOTCERT/);
  });
  it("does not leak the connection string or credentials when the CA is unusable", () => {
    let message = "";
    try { postgresTlsConnection(url, { ...production, PGSSLROOTCERT: path.join(directory, "missing.crt") }); } catch (error) { message = String(error); }
    expect(message).toMatch(/PGSSLROOTCERT/);
    expect(message).not.toContain("s3cret-pass");
    expect(message).not.toContain("db.test");
  });
  it("still rejects sslmode=disable, sslmode=no-verify and GETDONE_DB_SSL=false in production when a CA is configured", () => {
    const env = { ...production, PGSSLROOTCERT: caFile };
    expect(() => postgresTlsConnection(`${url}?sslmode=disable`, env)).toThrow(/certificate-verified TLS/);
    expect(() => postgresTlsConnection(`${url}?sslmode=no-verify`, env)).toThrow(/certificate-verified TLS/);
    expect(() => postgresTlsConnection(url, { ...env, GETDONE_DB_SSL: "false" })).toThrow(/certificate-verified TLS/);
  });
  it("does not read the CA when TLS is explicitly disabled for local test transport", () => {
    expect(postgresTlsConnection("postgres://localhost/db", { GETDONE_DB_SSL: "false", PGSSLROOTCERT: path.join(directory, "missing.crt") }).ssl).toBe(false);
  });
});
