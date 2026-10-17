import { X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rootCertificates } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const script = resolve("scripts/verify-staging-runtime-config.mjs");
const secret = "not-a-real-password";
const databaseUrl = "postgresql://postgres.ddxjiszbsmmbqxuoecmg:" + secret +
  "@aws-1-ca-central-1.pooler.supabase.com:5432/postgres";

describe("private staging runtime preflight", () => {
  let directory: string;
  let certificateFile: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "getdone-staging-preflight-"));
    certificateFile = join(directory, "root.crt");
    const trustedFixture = rootCertificates.find(pem => {
      try {
        const certificate = new X509Certificate(pem);
        return Date.parse(certificate.validFrom) < Date.now() && Date.parse(certificate.validTo) > Date.now();
      } catch { return false; }
    });
    if (!trustedFixture) throw new Error("Node TLS fixture has no current root certificate");
    writeFileSync(certificateFile, trustedFixture);
    env = {
      ...process.env,
      NODE_ENV: "test",
      GETDONE_RUNTIME_ENV: "staging",
      GETDONE_DATA_MODE: "authoritative",
      GETDONE_DB_SSL: "true",
      GETDONE_DB_RUNTIME_ROLE: "getdone_tenant_runtime",
      GETDONE_PROCESS_ROLE: "job-worker",
      GETDONE_INTERNAL_WORKER_TOKEN: "test-only-token-of-at-least-thirty-two-characters",
      DATABASE_URL: databaseUrl,
      PGSSLROOTCERT: certificateFile
    };
  });
  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function run(patch: Partial<NodeJS.ProcessEnv> = {}) {
    return spawnSync(process.execPath, [script], { env: { ...env, ...patch }, encoding: "utf8" });
  }

  it("accepts the exact staging pooler target without revealing secrets or claiming a network check", () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS: staging project target");
    expect(result.stdout).toContain("NOT TESTED: actual PostgreSQL TLS");
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(result.stdout + result.stderr).not.toContain("test-only-token-of-at-least-thirty-two-characters");
  });

  it.each([
    { label: "production environment", patch: { GETDONE_RUNTIME_ENV: "production" } },
    { label: "foreign database", patch: { DATABASE_URL: databaseUrl.replace("ddxjiszbsmmbqxuoecmg", "otherproject") } },
    { label: "unencrypted database", patch: { GETDONE_DB_SSL: "false" } },
    { label: "missing runtime role", patch: { GETDONE_DB_RUNTIME_ROLE: "" } },
    { label: "missing CA", patch: { PGSSLROOTCERT: "/missing/staging-ca.crt" } },
    { label: "invalid worker token", patch: { GETDONE_INTERNAL_WORKER_TOKEN: "short" } },
    { label: "TLS downgrade via URL", patch: { DATABASE_URL: databaseUrl + "?sslmode=disable" } }
  ])("fails closed for $label without leaking the connection password", ({ patch }) => {
    const result = run(patch);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("STAGING PREFLIGHT BLOCKED");
    expect(result.stdout + result.stderr).not.toContain(secret);
  });
});
