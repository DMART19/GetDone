import pg from "pg";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const requiredMigration = "2026-09-24.1";
const maxBackupAgeHours = Number(process.env.GETDONE_BACKUP_MAX_AGE_HOURS || "24");
if (!Number.isFinite(maxBackupAgeHours) || maxBackupAgeHours <= 0) {
  throw new Error("GETDONE_BACKUP_MAX_AGE_HOURS must be positive");
}

const pool = new pg.Pool({
  connectionString: required("DATABASE_URL"),
  max: 2,
  application_name: "getdone-production-verifier",
  ssl: process.env.GETDONE_DB_SSL === "false"
    ? false
    : { rejectUnauthorized: true }
});

const client = await pool.connect();
try {
  const version = await client.query("SHOW server_version_num");
  if (Number(version.rows[0]?.server_version_num) < 160000) {
    throw new Error("PostgreSQL 16+ is required");
  }

  const migration = await client.query(
    "SELECT version FROM getdone_schema_migrations ORDER BY version DESC LIMIT 1"
  );
  if (migration.rows[0]?.version !== requiredMigration) {
    throw new Error(`Database schema is not current; expected ${requiredMigration}`);
  }

  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const isolation = await client.query("SHOW transaction_isolation");
    if (isolation.rows[0]?.transaction_isolation !== "serializable") {
      throw new Error("Production transaction isolation is not serializable");
    }
    await client.query("CREATE TEMP TABLE getdone_rollback_probe(id integer) ON COMMIT DROP");
    await client.query("INSERT INTO getdone_rollback_probe(id) VALUES(1)");
    await client.query("ROLLBACK");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  }

  const rolledBack = await client.query(
    "SELECT to_regclass('pg_temp.getdone_rollback_probe') AS relation"
  );
  if (rolledBack.rows[0]?.relation !== null) {
    throw new Error("Rollback verification failed");
  }

  const constraints = await client.query(
    `SELECT indexname,indexdef FROM pg_indexes
     WHERE schemaname=current_schema()
       AND tablename IN (
         'authorization_consumptions',
         'job_leases',
         'job_runtime_transactions',
         'provider_concurrency_leases'
       )`
  );
  const indexText = constraints.rows.map((row) => row.indexdef).join("\n");
  for (const requiredFragment of [
    "authorization_consumptions",
    "job_leases",
    "job_runtime_transactions",
    "provider_concurrency_leases"
  ]) {
    if (!indexText.includes(requiredFragment)) {
      throw new Error(`Concurrency/idempotency index verification missing: ${requiredFragment}`);
    }
  }


  const rlsRelations = [
    "control_plane_entities",
    "audit_events",
    "authorization_grants",
    "authorization_consumptions",
    "verification_receipts",
    "job_execution_start_facts",
    "job_execution_completion_facts",
    "capacity_ledgers",
    "capacity_reservations",
    "reservation_commits",
    "owner_intents",
    "resource_evidence",
    "business_action_executions",
    "business_action_verification_evidence",
    "credential_leases",
    "credential_usage_audits"
  ];
  const rls = await client.query(
    `SELECT required.name, relation.relrowsecurity, relation.relforcerowsecurity
     FROM unnest($1::text[]) AS required(name)
     LEFT JOIN pg_class relation ON relation.oid=to_regclass(required.name)`,
    [rlsRelations]
  );
  const unsafeRls = rls.rows.filter(
    (row) => row.relrowsecurity !== true || row.relforcerowsecurity !== true
  );
  if (unsafeRls.length > 0) {
    throw new Error(
      `Tenant RLS is not enabled and forced on: ${unsafeRls.map((row) => row.name).join(", ")}`
    );
  }

  const runtimeRole = await client.query(
    `SELECT rolsuper,rolbypassrls
     FROM pg_roles
     WHERE rolname='getdone_tenant_runtime'`
  );
  if (
    runtimeRole.rows.length !== 1
    || runtimeRole.rows[0].rolsuper
    || runtimeRole.rows[0].rolbypassrls
  ) {
    throw new Error("Tenant runtime role must exist without superuser/BYPASSRLS");
  }
  const roleMembership = await client.query(
    "SELECT pg_has_role(current_user,'getdone_tenant_runtime','MEMBER') AS member"
  );
  if (roleMembership.rows[0]?.member !== true) {
    throw new Error("Migration/runtime principal cannot SET ROLE getdone_tenant_runtime");
  }

  await client.query('SET ROLE "getdone_tenant_runtime"');
  try {
    const effectiveRuntimeRole = await client.query(
      `SELECT current_user AS role_name, role.rolsuper, role.rolbypassrls
       FROM pg_roles role
       WHERE role.rolname=current_user`
    );
    const effective = effectiveRuntimeRole.rows[0];
    if (
      effective?.role_name !== "getdone_tenant_runtime"
      || effective.rolsuper
      || effective.rolbypassrls
    ) {
      throw new Error("Effective PostgreSQL runtime role is not RLS-safe");
    }
  } finally {
    await client.query("RESET ROLE");
  }

  const authSchema = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM unnest(ARRAY[
       'companies',
       'company_memberships',
       'auth_sessions',
       'auth_webauthn_credentials',
       'auth_step_up_challenges',
       'auth_sign_in_challenges'
     ]::text[]) AS required(name)
     WHERE to_regclass(required.name) IS NOT NULL`
  );
  if (authSchema.rows[0]?.count !== 6) {
    throw new Error("Production auth persistence schema verification failed");
  }

  const workerSchema = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM unnest(ARRAY[
       'job_worker_instances',
       'business_action_verification_evidence',
       'provider_concurrency_leases',
       'credential_leases',
       'credential_usage_audits'
     ]::text[]) AS required(name)
     WHERE to_regclass(required.name) IS NOT NULL`
  );
  if (workerSchema.rows[0]?.count !== 5) {
    throw new Error("Durable worker/credential broker persistence schema verification failed");
  }

  const backup = await client.query(
    `SELECT completed_at,verification_hash
     FROM database_backup_evidence
     WHERE status='verified'
     ORDER BY completed_at DESC LIMIT 1`
  );
  const latest = backup.rows[0];
  if (!latest || !/^[a-f0-9]{64}$/i.test(latest.verification_hash)) {
    throw new Error("No cryptographically verified backup evidence is recorded");
  }
  const backupAgeMs = Date.now() - Date.parse(
    latest.completed_at instanceof Date
      ? latest.completed_at.toISOString()
      : String(latest.completed_at)
  );
  if (backupAgeMs < 0 || backupAgeMs > maxBackupAgeHours * 60 * 60_000) {
    throw new Error("Latest verified backup evidence is stale");
  }

  const audit = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.columns
     WHERE table_name='audit_events'
       AND column_name IN ('id','correlation_id','entity_type','entity_id','occurred_at','payload')`
  );
  if (audit.rows[0]?.count !== 6) {
    throw new Error("Audit ledger schema integrity verification failed");
  }

  console.log(JSON.stringify({
    database: "reachable",
    minimumVersion: "16",
    migration: requiredMigration,
    transactionIsolation: "serializable",
    rollback: "verified",
    concurrencyConstraints: "verified",
    tenantRls: "verified",
    tenantRuntimeRole: "verified",
    effectiveRuntimeRole: "verified",
    auditSchema: "verified",
    authSchema: "verified",
    durableWorkerSchema: "verified",
    backupFresh: true
  }, null, 2));
} finally {
  client.release();
  await pool.end();
}
