import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";
import { ControlPlaneError } from "@/lib/control-plane/errors";

export const POSTGRES_PERSISTENCE_VERSION = "1.0.0";

export interface SqlQueryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<R>>;
}

export interface PostgresTransactionalDatabase extends SqlQueryable {
  transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T>;
}

export interface PostgresConnectionConfig {
  connectionString: string;
  maxConnections?: number;
  statementTimeoutMs?: number;
  ssl?: boolean;
}

export function readPostgresConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): PostgresConnectionConfig {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new ControlPlaneError("UNAVAILABLE", "DATABASE_URL is required for PostgreSQL persistence");
  }
  const url = new URL(connectionString);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ControlPlaneError("VALIDATION_FAILED", "DATABASE_URL must use postgres:// or postgresql://");
  }
  return {
    connectionString,
    maxConnections: env.GETDONE_DB_POOL_MAX ? Number(env.GETDONE_DB_POOL_MAX) : 10,
    statementTimeoutMs: env.GETDONE_DB_STATEMENT_TIMEOUT_MS
      ? Number(env.GETDONE_DB_STATEMENT_TIMEOUT_MS)
      : 15_000,
    ssl: env.GETDONE_DB_SSL !== "false"
  };
}

export class PostgresDatabase implements PostgresTransactionalDatabase {
  readonly pool: Pool;

  constructor(config: PostgresConnectionConfig) {
    const poolConfig: PoolConfig = {
      connectionString: config.connectionString,
      max: config.maxConnections ?? 10,
      statement_timeout: config.statementTimeoutMs ?? 15_000,
      application_name: "getdone-control-plane",
      ssl: config.ssl === false ? false : { rejectUnauthorized: true }
    };
    this.pool = new Pool(poolConfig);
    const logConnectionError = (error: unknown, source: "pool" | "client") => {
      const code = (
        error
        && typeof error === "object"
        && "code" in error
        && typeof (error as { code?: unknown }).code === "string"
      ) ? (error as { code: string }).code : "UNKNOWN";
      console.error("PostgreSQL connection error", { source, code });
    };
    this.pool.on("error", (error) => logConnectionError(error, "pool"));
    this.pool.on("connect", (client) => {
      client.on("error", (error) => logConnectionError(error, "client"));
    });
  }

  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ) {
    return this.pool.query<R>(text, values as unknown[]);
  }

  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      const code = (
        error
        && typeof error === "object"
        && "code" in error
        && typeof (error as { code?: unknown }).code === "string"
      ) ? (error as { code: string }).code : undefined;
      if (code === "40001" || code === "40P01") {
        throw new ControlPlaneError(
          "CONFLICT",
          "Concurrent PostgreSQL transaction conflicted; retry with the same idempotency key",
          { details: { postgresCode: code } }
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

export function postgresConflict(message: string, details?: Record<string, string | number | boolean | null>) {
  return new ControlPlaneError("CONFLICT", message, { details });
}
