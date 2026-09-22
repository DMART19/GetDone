import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  PostgresDatabase,
  readPostgresConfigFromEnv
} from "@/lib/persistence/postgres/client";

export const REQUIRED_POSTGRES_MIGRATION = "2026-09-22.4";

export interface PostgresRuntimeHealth {
  connected: boolean;
  schemaCurrent: boolean;
  latestMigration?: string;
  backupFresh: boolean;
  latestVerifiedBackupAt?: string;
}

export class PostgresRuntime {
  constructor(
    readonly database: PostgresDatabase,
    private readonly backupMaxAgeHours = 24
  ) {}

  async health(now = Date.now()): Promise<PostgresRuntimeHealth> {
    try {
      await this.database.query("SELECT 1");
      const migrations = await this.database.query<{ version: string }>(
        "SELECT version FROM getdone_schema_migrations ORDER BY version DESC LIMIT 1"
      );
      const latestMigration = migrations.rows[0]?.version;
      let latestVerifiedBackupAt: string | undefined;
      try {
        const backups = await this.database.query<{ completed_at: Date | string }>(
          `SELECT completed_at FROM database_backup_evidence
           WHERE status='verified'
           ORDER BY completed_at DESC LIMIT 1`
        );
        const value = backups.rows[0]?.completed_at;
        latestVerifiedBackupAt = value instanceof Date ? value.toISOString() : value;
      } catch {
        latestVerifiedBackupAt = undefined;
      }
      const backupFresh = Boolean(
        latestVerifiedBackupAt
        && now - Date.parse(latestVerifiedBackupAt) <= this.backupMaxAgeHours * 60 * 60_000
      );
      return {
        connected: true,
        schemaCurrent: latestMigration === REQUIRED_POSTGRES_MIGRATION,
        latestMigration,
        backupFresh,
        latestVerifiedBackupAt
      };
    } catch {
      return {
        connected: false,
        schemaCurrent: false,
        backupFresh: false
      };
    }
  }

  async assertReady() {
    const health = await this.health();
    if (!health.connected) {
      throw new ControlPlaneError("UNAVAILABLE", "PostgreSQL production persistence is not reachable");
    }
    if (!health.schemaCurrent) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        `PostgreSQL schema is not current; required migration ${REQUIRED_POSTGRES_MIGRATION}`
      );
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

export async function resetPostgresRuntimeForTests() {
  const current = installed;
  installed = null;
  if (current) await current.database.close();
}
