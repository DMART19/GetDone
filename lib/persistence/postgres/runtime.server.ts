import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  PostgresDatabase,
  readPostgresConfigFromEnv
} from "@/lib/persistence/postgres/client";

export const REQUIRED_POSTGRES_MIGRATION = "2026-09-22.3";

export const REQUIRED_POSTGRES_RELATIONS = Object.freeze([
  "getdone_schema_migrations",
  "control_plane_entities",
  "idempotency_records",
  "audit_events",
  "authorization_grants",
  "authorization_consumptions",
  "verification_receipts",
  "job_execution_start_facts",
  "job_execution_completion_facts",
  "capacity_ledgers",
  "capacity_reservations",
  "reservation_commits",
  "job_runtime_state",
  "job_runtime_transactions",
  "job_leases",
  "job_retry_schedule",
  "job_dead_letters",
  "job_recovery_records",
  "job_execution_specs",
  "business_action_executions",
  "software_pipeline_records",
  "database_backup_evidence",
  "auth_users",
  "auth_sessions",
  "auth_webauthn_credentials",
  "auth_step_up_challenges",
  "auth_sign_in_challenges",
  "organizations",
  "companies",
  "portfolios",
  "organization_memberships",
  "company_memberships",
  "portfolio_memberships",
  "owner_intents",
  "job_execution_outcomes",
  "job_worker_instances",
  "business_action_verification_evidence"
] as const);

export const REQUIRED_POSTGRES_INDEXES = Object.freeze([
  "control_plane_entities_scope_idx",
  "audit_events_correlation_idx",
  "job_runtime_ready_idx",
  "job_leases_one_active_per_job",
  "job_leases_expiry_idx",
  "job_worker_instances_status_idx",
  "business_action_verification_scope_idx"
] as const);

export interface PostgresRuntimeHealth {
  connected: boolean;
  inspectionSucceeded: boolean;
  ready: boolean;
  schemaCurrent: boolean;
  latestMigration?: string;
  requiredRelationsPresent: boolean;
  missingRelations: readonly string[];
  requiredIndexesPresent: boolean;
  missingIndexes: readonly string[];
  transactionIsolationSerializable: boolean;
  transactionIsolation?: string;
  backupFresh: boolean;
  latestVerifiedBackupAt?: string;
}

interface PresenceRow {
  name: string;
  present: boolean;
}

const unavailableHealth = (): PostgresRuntimeHealth => ({
  connected: false,
  inspectionSucceeded: false,
  ready: false,
  schemaCurrent: false,
  requiredRelationsPresent: false,
  missingRelations: REQUIRED_POSTGRES_RELATIONS,
  requiredIndexesPresent: false,
  missingIndexes: REQUIRED_POSTGRES_INDEXES,
  transactionIsolationSerializable: false,
  backupFresh: false
});

export class PostgresRuntime {
  constructor(
    readonly database: PostgresDatabase,
    private readonly backupMaxAgeHours = 24
  ) {}

  private async missingObjects(names: readonly string[]) {
    const result = await this.database.query<PresenceRow>(
      `SELECT name, to_regclass(name) IS NOT NULL AS present
       FROM unnest($1::text[]) AS required(name)`,
      [names]
    );
    return result.rows.filter((row) => !row.present).map((row) => row.name);
  }

  async health(now = Date.now()): Promise<PostgresRuntimeHealth> {
    try {
      await this.database.query("SELECT 1");
    } catch {
      return unavailableHealth();
    }

    try {
      const missingRelations = await this.missingObjects(REQUIRED_POSTGRES_RELATIONS);
      const missingIndexes = await this.missingObjects(REQUIRED_POSTGRES_INDEXES);
      const requiredRelationsPresent = missingRelations.length === 0;
      const requiredIndexesPresent = missingIndexes.length === 0;

      let latestMigration: string | undefined;
      if (!missingRelations.includes("getdone_schema_migrations")) {
        const migrations = await this.database.query<{ version: string }>(
          "SELECT version FROM getdone_schema_migrations ORDER BY version DESC LIMIT 1"
        );
        latestMigration = migrations.rows[0]?.version;
      }
      const schemaCurrent = latestMigration === REQUIRED_POSTGRES_MIGRATION;

      const transactionIsolation = await this.database.serializableTransactionIsolation();
      const transactionIsolationSerializable = transactionIsolation === "serializable";

      let latestVerifiedBackupAt: string | undefined;
      let backupFresh = false;
      if (!missingRelations.includes("database_backup_evidence")) {
        const backups = await this.database.query<{
          completed_at: Date | string;
          verification_hash: string;
        }>(
          `SELECT completed_at,verification_hash
           FROM database_backup_evidence
           WHERE status='verified'
           ORDER BY completed_at DESC LIMIT 1`
        );
        const latest = backups.rows[0];
        if (latest && /^[a-f0-9]{64}$/i.test(latest.verification_hash)) {
          const value = latest.completed_at;
          latestVerifiedBackupAt = value instanceof Date ? value.toISOString() : String(value);
          const ageMs = now - Date.parse(latestVerifiedBackupAt);
          backupFresh = Number.isFinite(ageMs)
            && ageMs >= 0
            && ageMs <= this.backupMaxAgeHours * 60 * 60_000;
        }
      }

      const ready = schemaCurrent
        && requiredRelationsPresent
        && requiredIndexesPresent
        && transactionIsolationSerializable
        && backupFresh;

      return {
        connected: true,
        inspectionSucceeded: true,
        ready,
        schemaCurrent,
        latestMigration,
        requiredRelationsPresent,
        missingRelations,
        requiredIndexesPresent,
        missingIndexes,
        transactionIsolationSerializable,
        transactionIsolation,
        backupFresh,
        latestVerifiedBackupAt
      };
    } catch {
      return {
        ...unavailableHealth(),
        connected: true
      };
    }
  }

  async assertReady() {
    const health = await this.health();
    if (!health.connected) {
      throw new ControlPlaneError("UNAVAILABLE", "PostgreSQL production persistence is not reachable");
    }
    if (!health.inspectionSucceeded) {
      throw new ControlPlaneError("UNAVAILABLE", "PostgreSQL production readiness inspection failed");
    }
    if (!health.schemaCurrent) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        `PostgreSQL schema is not current; required migration ${REQUIRED_POSTGRES_MIGRATION}`
      );
    }
    if (!health.requiredRelationsPresent) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        `PostgreSQL required relations are missing: ${health.missingRelations.join(", ")}`
      );
    }
    if (!health.requiredIndexesPresent) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        `PostgreSQL required indexes are missing: ${health.missingIndexes.join(", ")}`
      );
    }
    if (!health.transactionIsolationSerializable) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "PostgreSQL production transaction isolation is not serializable"
      );
    }
    if (!health.backupFresh) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "PostgreSQL production backup verification evidence is missing, invalid, future-dated, or stale"
      );
    }
    if (!health.ready) {
      throw new ControlPlaneError("UNAVAILABLE", "PostgreSQL production persistence is not ready");
    }
    return health;
  }
}

let installed: PostgresRuntime | null = null;

export function getPostgresRuntimeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (installed) return installed;
  const config = readPostgresConfigFromEnv(env);
  const backupMaxAgeHours = env.GETDONE_BACKUP_MAX_AGE_HOURS
    ? Number(env.GETDONE_BACKUP_MAX_AGE_HOURS)
    : 24;
  if (!Number.isFinite(backupMaxAgeHours) || backupMaxAgeHours <= 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", "GETDONE_BACKUP_MAX_AGE_HOURS must be positive");
  }
  installed = new PostgresRuntime(new PostgresDatabase(config), backupMaxAgeHours);
  return installed;
}

export async function assertPostgresReadyAtStartup(
  env: Readonly<Record<string, string | undefined>> = process.env,
  runtime?: PostgresRuntime
) {
  const environment = env.GETDONE_RUNTIME_ENV?.trim();

  if (!environment) {
    if (env.NODE_ENV === "production") {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "GETDONE_RUNTIME_ENV is required before a production server can start"
      );
    }
    return null;
  }
  if (environment === "development") return null;
  if (environment !== "staging" && environment !== "production") {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "GETDONE_RUNTIME_ENV must be development, staging, or production"
    );
  }

  return (runtime ?? getPostgresRuntimeFromEnv(env)).assertReady();
}

export async function resetPostgresRuntimeForTests() {
  const current = installed;
  installed = null;
  if (current) await current.database.close();
}
