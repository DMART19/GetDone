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
  if (flags.some(flag => !["--connect", "--workers"].includes(flag))) fail("Only --connect and --workers are supported");
  if (flags.includes("--workers") && !flags.includes("--connect")) fail("--workers requires --connect");
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

      if (flags.includes("--workers")) {
        const requirements = {
          getdone_tenant_runtime: {
            readWrite: ["job_runtime_state","job_leases","job_retry_schedule","idempotency_records"],
            appendOnly: [
              "job_runtime_transactions","job_runtime_events","job_execution_outcomes",
              "job_recovery_records","job_dead_letters","job_execution_specs"
            ]
          },
          getdone_worker_registry: {
            readWrite: ["job_worker_instances","orchestration_worker_instances"],
            appendOnly: []
          }
        };
        const blocked = [];
        for (const [role, contract] of Object.entries(requirements)) {
          // Role names here are hard-coded constants, not operator-supplied SQL.
          await client.query('SET LOCAL ROLE "' + role + '"');
          for (const [tableName, needsUpdate] of [
            ...contract.readWrite.map(name => [name,true]),
            ...contract.appendOnly.map(name => [name,false])
          ]) {
            const checks = await client.query(
              `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
                 has_table_privilege(current_user,c.oid,'SELECT') AS can_read,
                 has_table_privilege(current_user,c.oid,'INSERT') AS can_insert,
                 has_table_privilege(current_user,c.oid,'UPDATE') AS can_update,
                 has_table_privilege(current_user,c.oid,'DELETE') AS can_delete,
                 (SELECT COUNT(*) FROM pg_policy p WHERE p.polrelid=c.oid
                   AND (0::oid=ANY(p.polroles)
                     OR (SELECT oid FROM pg_roles WHERE rolname=$2)=ANY(p.polroles))
                   AND p.polcmd IN ('*','r')) AS read_policies,
                 (SELECT COUNT(*) FROM pg_policy p WHERE p.polrelid=c.oid
                   AND (0::oid=ANY(p.polroles)
                     OR (SELECT oid FROM pg_roles WHERE rolname=$2)=ANY(p.polroles))
                   AND p.polcmd IN ('*','a')) AS insert_policies,
                 (SELECT COUNT(*) FROM pg_policy p WHERE p.polrelid=c.oid
                   AND (0::oid=ANY(p.polroles)
                     OR (SELECT oid FROM pg_roles WHERE rolname=$2)=ANY(p.polroles))
                   AND p.polcmd IN ('*','w')) AS update_policies
               FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
               WHERE n.nspname='public' AND c.relname=$1`,
              [tableName,role]
            );
            const row = checks.rows[0];
            if (!row || !row.rls || !row.forced ||
              !row.can_read || !row.can_insert || row.can_delete ||
              (needsUpdate && !row.can_update) ||
              (!needsUpdate && row.can_update) ||
              Number(row.read_policies)<1 || Number(row.insert_policies)<1 ||
              (needsUpdate && Number(row.update_policies)<1)) {
              blocked.push(role + ":" + tableName);
            }
          }
        }
        await client.query('SET LOCAL ROLE "getdone_job_dispatch"');
        const dispatchStatus = await client.query(
          `SELECT has_function_privilege(current_user,
             'public.getdone_discover_ready_jobs(timestamptz,integer)','EXECUTE') AS ready,
             has_function_privilege(current_user,
             'public.getdone_discover_expired_jobs(timestamptz,integer)','EXECUTE') AS recovery,
             has_table_privilege(current_user,'public.job_runtime_state','SELECT') AS raw_job_access`
        );
        if (!dispatchStatus.rows[0]?.ready || !dispatchStatus.rows[0]?.recovery ||
          dispatchStatus.rows[0]?.raw_job_access) blocked.push("getdone_job_dispatch:read-only-function-access");
        if (blocked.length) fail("WORKER_RLS_BLOCKED: " + blocked.join(", "));
        console.log("PASS: role-scoped job state, append-only lineage, registry and bounded discovery grants");
        console.log("NOT TESTED: actual worker DML, leases, retries or cross-tenant isolation");
      }

    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("WORKER_RLS_BLOCKED:")) fail(error.message);
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
