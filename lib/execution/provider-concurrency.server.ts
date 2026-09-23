import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";

export interface ProviderConcurrencyConfig {
  defaultLimit: number;
  leaseSeconds: number;
  limits: Readonly<Record<string, number>>;
}

export interface ProviderConcurrencyGate {
  withPermit<T>(
    input: {
      providerKey: string;
      requestId: string;
      portfolioId: string;
      companyId: string;
      operation: "execute" | "status" | "cancel";
    },
    operation: () => Promise<T>
  ): Promise<T>;
}

function positiveInteger(value: unknown, fallback: number, label: string) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a positive integer`);
  }
  return parsed;
}

export function readProviderConcurrencyConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): ProviderConcurrencyConfig {
  const defaultLimit = positiveInteger(
    env.GETDONE_PROVIDER_CONCURRENCY_LIMIT,
    4,
    "GETDONE_PROVIDER_CONCURRENCY_LIMIT"
  );
  const leaseSeconds = positiveInteger(
    env.GETDONE_PROVIDER_CONCURRENCY_LEASE_SECONDS,
    120,
    "GETDONE_PROVIDER_CONCURRENCY_LEASE_SECONDS"
  );
  const raw = env.GETDONE_PROVIDER_CONCURRENCY_LIMITS_JSON?.trim();
  let limits: Record<string, number> = {};
  if (raw) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "GETDONE_PROVIDER_CONCURRENCY_LIMITS_JSON must be valid JSON"
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "GETDONE_PROVIDER_CONCURRENCY_LIMITS_JSON must be an object"
      );
    }
    limits = Object.fromEntries(Object.entries(parsed).map(([providerKey, value]) => {
      if (!providerKey.trim()) {
        throw new ControlPlaneError("VALIDATION_FAILED","Provider concurrency override keys must be non-empty");
      }
      return [providerKey, positiveInteger(value, defaultLimit, `Provider concurrency limit for ${providerKey}`)];
    }));
  }
  return Object.freeze({ defaultLimit, leaseSeconds, limits: Object.freeze(limits) });
}

export class PostgresProviderConcurrencyGate implements ProviderConcurrencyGate {
  constructor(
    private readonly database: PostgresTransactionalDatabase,
    private readonly config: ProviderConcurrencyConfig,
    private readonly now: () => Date = () => new Date()
  ) {}

  private limitFor(providerKey: string) {
    return this.config.limits[providerKey] ?? this.config.defaultLimit;
  }

  async withPermit<T>(
    input: {
      providerKey: string;
      requestId: string;
      portfolioId: string;
      companyId: string;
      operation: "execute" | "status" | "cancel";
    },
    operation: () => Promise<T>
  ): Promise<T> {
    const providerKey = input.providerKey.trim();
    if (!providerKey) throw new ControlPlaneError("VALIDATION_FAILED","Provider concurrency key is required");
    const limit = this.limitFor(providerKey);
    const acquiredAt = this.now().toISOString();
    const expiresAt = new Date(Date.parse(acquiredAt) + this.config.leaseSeconds * 1_000).toISOString();
    const permitId = crypto.randomUUID();

    const acquired = await this.database.transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`getdone:provider-concurrency:${providerKey}`]);
      await db.query(
        "DELETE FROM provider_concurrency_leases WHERE provider_key=$1 AND expires_at <= $2",
        [providerKey, acquiredAt]
      );
      const current = await db.query<{ active: string | number }>(
        `SELECT COUNT(*) AS active
         FROM provider_concurrency_leases
         WHERE provider_key=$1 AND expires_at > $2`,
        [providerKey, acquiredAt]
      );
      if (Number(current.rows[0]?.active ?? 0) >= limit) return false;
      await db.query(
        `INSERT INTO provider_concurrency_leases
          (id,provider_key,request_id,portfolio_id,company_id,operation,acquired_at,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [permitId,providerKey,input.requestId,input.portfolioId,input.companyId,input.operation,acquiredAt,expiresAt]
      );
      return true;
    });

    if (!acquired) {
      throw new ControlPlaneError("UNAVAILABLE", `Provider concurrency is saturated for ${providerKey}`, {
        details: {
          reason: "PROVIDER_CONCURRENCY_SATURATED",
          providerKey,
          limit,
          retryable: true,
          retryAfterMs: this.config.leaseSeconds * 1_000
        }
      });
    }

    try {
      return await operation();
    } finally {
      try {
        await this.database.query("DELETE FROM provider_concurrency_leases WHERE id=$1", [permitId]);
      } catch {
        // Expiry recovers capacity if cleanup is interrupted.
      }
    }
  }
}
