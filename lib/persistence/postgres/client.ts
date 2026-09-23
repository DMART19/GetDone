import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { getPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";

export const POSTGRES_PERSISTENCE_VERSION = "1.1.0";

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
  connectionTimeoutMs?: number;
  runtimeRole?: string;
  ssl?: boolean;
}

function positiveInteger(value: string | undefined, fallback: number, label: string) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a positive integer`);
  }
  return parsed;
}

function runtimeRole(value: string | undefined) {
  const role = value?.trim();
  if (!role) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(role)) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "GETDONE_DB_RUNTIME_ROLE must be a safe PostgreSQL role identifier"
    );
  }
  return role;
}

function quoteRole(role: string) {
  return `"${role.replaceAll('"', '""')}"`;
}

export function readPostgresConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): PostgresConnectionConfig {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new ControlPlaneError("UNAVAILABLE", "DATABASE_URL is required for PostgreSQL persistence");
  }

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new ControlPlaneError("VALIDATION_FAILED", "DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ControlPlaneError("VALIDATION_FAILED", "DATABASE_URL must use postgres:// or postgresql://");
  }

  return {
    connectionString,
    maxConnections: positiveInteger(env.GETDONE_DB_POOL_MAX, 10, "GETDONE_DB_POOL_MAX"),
    statementTimeoutMs: positiveInteger(
      env.GETDONE_DB_STATEMENT_TIMEOUT_MS,
      15_000,
      "GETDONE_DB_STATEMENT_TIMEOUT_MS"
    ),
    connectionTimeoutMs: positiveInteger(
      env.GETDONE_DB_CONNECTION_TIMEOUT_MS,
      5_000,
      "GETDONE_DB_CONNECTION_TIMEOUT_MS"
    ),
    runtimeRole: runtimeRole(env.GETDONE_DB_RUNTIME_ROLE),
    ssl: env.GETDONE_DB_SSL !== "false"
  };
}

export class PostgresDatabase implements PostgresTransactionalDatabase {
  readonly pool: Pool;
  private readonly runtimeRole?: string;

  constructor(config: PostgresConnectionConfig) {
    this.runtimeRole = config.runtimeRole;
    const poolConfig: PoolConfig = {
      connectionString: config.connectionString,
      max: config.maxConnections ?? 10,
      statement_timeout: config.statementTimeoutMs ?? 15_000,
      connectionTimeoutMillis: config.connectionTimeoutMs ?? 5_000,
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

  private async connectRuntimeClient() {
    const client = await this.pool.connect();
    try {
      if (this.runtimeRole) {
        await client.query(`SET ROLE ${quoteRole(this.runtimeRole)}`);
      }
      return client;
    } catch (error) {
      await this.releaseRuntimeClient(client);
      throw error;
    }
  }

  private async applyTenantScope(client: PoolClient) {
    const scope = getPostgresTenantScope();
    if (!scope) return;
    await client.query(
      `SELECT
         set_config('getdone.portfolio_id',$1,true),
         set_config('getdone.company_id',$2,true)`,
      [scope.portfolioId, scope.companyId]
    );
  }

  private async releaseRuntimeClient(client: PoolClient) {
    try {
      if (this.runtimeRole) await client.query("RESET ROLE");
    } finally {
      await this.releaseRuntimeClient(client);
    }
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<R>> {
    const scope = getPostgresTenantScope();
    const client = await this.connectRuntimeClient();
    if (!scope) {
      try {
        return await client.query<R>(text, values as unknown[]);
      } finally {
        await this.releaseRuntimeClient(client);
      }
    }

    try {
      await client.query("BEGIN");
      await this.applyTenantScope(client);
      const result = await client.query<R>(text, values as unknown[]);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      await this.releaseRuntimeClient(client);
    }
  }

  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.connectRuntimeClient();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await this.applyTenantScope(client);
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
      await this.releaseRuntimeClient(client);
    }
  }

  async serializableTransactionIsolation() {
    const client = await this.connectRuntimeClient();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY");
      const result = await client.query<{ transaction_isolation: string }>(
        "SHOW transaction_isolation"
      );
      await client.query("ROLLBACK");
      return result.rows[0]?.transaction_isolation;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      await this.releaseRuntimeClient(client);
    }
  }

  async close() {
    await this.pool.end();
  }
}

export function postgresConflict(message: string, details?: Record<string, string | number | boolean | null>) {
  return new ControlPlaneError("CONFLICT", message, { details });
}
