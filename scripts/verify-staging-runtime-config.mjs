#!/usr/bin/env node
/**
 * Private, fail-closed staging configuration preflight. No secrets or connection URLs are printed.
 * Default: static checks. Optional --connect performs a read-only PostgreSQL TLS connection.
 */
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import pg from "pg";
import { postgresTlsConnection } from "../lib/persistence/postgres/tls.ts";

const PROJECT_ID = "ddxjiszbsmmbqxuoecmg";
const STAGING_POOLER = "aws-1-ca-central-1.pooler.supabase.com";
const ROLES = new Set(["web", "job-worker", "orchestration-worker"]);

function fail(message) {
  throw new Error(message);
}
function requireValue(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(name + " is missing");
  return value;
}

async function main() {
  const flags = process.argv.slice(2);
  if (flags.some(flag => flag !== "--connect")) fail("Only --connect is supported");
  if (requireValue("GETDONE_RUNTIME_ENV") !== "staging") fail("GETDONE_RUNTIME_ENV must be staging");
  if (requireValue("GETDONE_DATA_MODE") !== "authoritative") fail("GETDONE_DATA_MODE must be authoritative");
  if (requireValue("GETDONE_DB_SSL") !== "true") fail("GETDONE_DB_SSL must be true");
  if (requireValue("GETDONE_DB_RUNTIME_ROLE") !== "getdone_tenant_runtime") fail("GETDONE_DB_RUNTIME_ROLE must be getdone_tenant_runtime");
  if (!ROLES.has(requireValue("GETDONE_PROCESS_ROLE"))) fail("GETDONE_PROCESS_ROLE must be web, job-worker or orchestration-worker");
  if (requireValue("GETDONE_INTERNAL_WORKER_TOKEN").length < 32) fail("GETDONE_INTERNAL_WORKER_TOKEN must have at least 32 characters");

  let url;
  try { url = new URL(requireValue("DATABASE_URL")); }
  catch { fail("DATABASE_URL is not a valid PostgreSQL URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.password || !url.username) {
    fail("DATABASE_URL must contain authenticated PostgreSQL connection details");
  }
  const direct = url.hostname === "db." + PROJECT_ID + ".supabase.co"
    && decodeURIComponent(url.username) === "postgres";
  const pooled = url.hostname === STAGING_POOLER
    && decodeURIComponent(url.username) === "postgres." + PROJECT_ID
    && (url.port === "5432" || !url.port);
  if (!direct && !pooled) fail("DATABASE_URL is not the approved GetDone staging Supabase target");
  const root = requireValue("PGSSLROOTCERT");
  let certificate;
  try {
    const pem = readFileSync(root, "utf8");
    const first = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
    if (!first) fail("PGSSLROOTCERT is not a PEM certificate");
    certificate = new X509Certificate(first);
  } catch {
    fail("PGSSLROOTCERT is not a readable valid X.509 PEM certificate");
  }
  if (Date.parse(certificate.validTo) <= Date.now() || Date.parse(certificate.validFrom) > Date.now()) {
    fail("PGSSLROOTCERT certificate is not currently valid");
  }
  // Reuse the production-verified TLS option builder. It rejects staging TLS opt-outs.
  postgresTlsConnection(process.env.DATABASE_URL, process.env);
  console.log("PASS: staging project target and runtime roles match the approved configuration");
  console.log("PASS: configured CA is a readable, currently valid X.509 certificate (remote trust not yet tested)");
  console.log("PASS: internal worker token present (secret value withheld)");

  if (!flags.includes("--connect")) {
    console.log("NOT TESTED: actual PostgreSQL TLS chain, hostname and database login; rerun with --connect");
    return;
  }
  const pool = new pg.Pool({
    ...postgresTlsConnection(process.env.DATABASE_URL, process.env),
    max: 1,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 1000,
    application_name: "getdone-staging-readonly-preflight"
  });
  let transportReady = false;
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT 1 AS staging_tls_readiness");
      transportReady = true;
      console.log("PASS: authenticated, certificate-verified PostgreSQL query succeeded");
      // Pre-authentication queries need to resolve the owner without tenant scope.
      // A granted SELECT privilege is not sufficient if row-level security hides every row.
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query("SET LOCAL ROLE getdone_auth_runtime");
      const result = await client.query(
        "SELECT current_user AS role, (SELECT COUNT(*) FROM auth_users) AS users, " +
        "(SELECT COUNT(*) FROM company_memberships) AS memberships"
      );
      if (result.rows[0]?.role !== "getdone_auth_runtime"
        || Number(result.rows[0]?.users) < 1 || Number(result.rows[0]?.memberships) < 1) {
        fail("AUTH_VISIBILITY_DENIED");
      }
      console.log("PASS: restricted auth role can resolve an owner and business membership");
      await client.query("SET LOCAL ROLE getdone_tenant_runtime");
      const tenant = await client.query(
        "SELECT (SELECT COUNT(*) FROM auth_users) AS users, " +
        "(SELECT COUNT(*) FROM company_memberships) AS memberships"
      );
      if (Number(tenant.rows[0]?.users) !== 0 || Number(tenant.rows[0]?.memberships) !== 0) {
        fail("TENANT_AUTH_ISOLATION_BROKEN");
      }
      console.log("PASS: business tenant role cannot read unscoped authentication data");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  } catch (error) {
    if (transportReady) {
      fail("staging auth runtime cannot resolve authorized identity or isolation; review dedicated role migration and RLS");
    }
    fail("staging PostgreSQL connection or TLS verification failed; inspect trusted CA and private configuration");
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  // Never log exception objects, URLs, certificate material or environment values.
  console.error("STAGING PREFLIGHT BLOCKED:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
