import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  PostgresDatabase,
  readPostgresConfigFromEnv,
  type PostgresConnectionConfig
} from "@/lib/persistence/postgres/client";

export const GETDONE_AUTH_RUNTIME_ROLE = "getdone_auth_runtime" as const;

/**
 * An explicit, separate server-only PostgreSQL role for identity lookups that
 * happen before the tenant is known. Never inject this database into a
 * business, execution or orchestration store.
 *
 * Same verified-TLS DATABASE_URL, but connection clients always SET ROLE
 * getdone_auth_runtime, which has no rights on business/execution relations.
 */
export function readAuthPostgresConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): PostgresConnectionConfig {
  if (!["staging", "production"].includes(env.GETDONE_RUNTIME_ENV ?? "")) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "Dedicated PostgreSQL authentication runtime requires staging or production"
    );
  }
  return {
    ...readPostgresConfigFromEnv(env),
    runtimeRole: GETDONE_AUTH_RUNTIME_ROLE,
    maxConnections: 3
  };
}

let authDatabase: PostgresDatabase | undefined;

/** The auth pool is shared for the life of the web process, never per HTTP request. */
export function getAuthPostgresDatabaseFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): PostgresDatabase {
  const config = readAuthPostgresConfigFromEnv(env);
  if (!authDatabase) {
    authDatabase = new PostgresDatabase(config);
  }
  return authDatabase;
}

/** For isolated integration/unit test teardown only; not an operational switch. */
export async function closeAuthPostgresDatabaseForTests() {
  const database = authDatabase;
  authDatabase = undefined;
  if (database) await database.close();
}
