import type { ModelProfile } from "@/lib/ai-gateway/contracts";
import {
  isAIGatewayConfigured,
  readAIGatewayRuntimeConfig
} from "@/lib/ai-gateway/runtime.server";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";

export const AI_GATEWAY_HEALTH_SURFACE_VERSION = "1.0.0";
const CANARY_ENTITY_TYPE = "ai-gateway-canary";

export interface AIGatewayOwnerHealth {
  surfaceVersion: string;
  configured: boolean;
  status: "ready" | "degraded" | "not-configured";
  activeRoutingPolicyVersion: string | null;
  lastSuccessfulCanaryAt: string | null;
  primary: {
    configured: boolean;
    available: boolean;
    lastSuccessfulCallAt: string | null;
  };
  fallback: {
    configured: boolean;
    available: boolean;
    lastSuccessfulCallAt: string | null;
  };
  recentErrorClass: string | null;
  budget: {
    configured: boolean;
    status: "healthy" | "near-limit" | "exhausted" | "unknown";
    period: string;
    spentCents: number;
    limitCents: number | null;
    remainingCents: number | null;
  };
}

function isProfileAvailable(
  profile: ModelProfile | undefined,
  environment: TrustedExecutionScope["environment"]
) {
  return Boolean(
    profile
    && profile.enabled
    && profile.validationStatus === "validated"
    && profile.health === "healthy"
    && profile.allowedEnvironments.includes(environment)
  );
}

function monthlyBudgetCents(
  env: Readonly<Record<string, string | undefined>>
): number | null {
  const raw = env.GETDONE_AI_MONTHLY_COMPANY_BUDGET_CENTS?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function monthStart(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function periodLabel(now: Date) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function latestProfileSuccess(
  db: SqlQueryable,
  scope: TrustedExecutionScope,
  profileId: string | undefined
) {
  if (!profileId) return null;
  const result = await db.query<{ recorded_at: Date | string }>(
    `SELECT recorded_at
     FROM ai_call_audits
     WHERE portfolio_id=$1
       AND company_id=$2
       AND validation_status='valid'
       AND payload->>'actualProfileId'=$3
     ORDER BY recorded_at DESC
     LIMIT 1`,
    [scope.portfolioId, scope.companyId, profileId]
  );
  const value = result.rows[0]?.recorded_at;
  return value instanceof Date ? value.toISOString() : value ? String(value) : null;
}

async function recentErrorClass(
  db: SqlQueryable,
  scope: TrustedExecutionScope,
  since: Date
) {
  const result = await db.query<{ failure_class: string | null }>(
    `SELECT payload->>'failureClass' AS failure_class
     FROM ai_call_audits
     WHERE portfolio_id=$1
       AND company_id=$2
       AND recorded_at >= $3
       AND COALESCE(payload->>'failureClass','') <> ''
     ORDER BY recorded_at DESC
     LIMIT 1`,
    [scope.portfolioId, scope.companyId, since.toISOString()]
  );
  return result.rows[0]?.failure_class ?? null;
}

async function lastSuccessfulCanary(
  db: SqlQueryable,
  scope: TrustedExecutionScope
) {
  const result = await db.query<{ observed_at: string | null }>(
    `SELECT payload->>'observedAt' AS observed_at
     FROM control_plane_entities
     WHERE entity_type=$1
       AND portfolio_id=$2
       AND company_id=$3
     ORDER BY updated_at DESC
     LIMIT 1`,
    [CANARY_ENTITY_TYPE, scope.portfolioId, scope.companyId]
  );
  return result.rows[0]?.observed_at ?? null;
}

async function monthlySpend(
  db: SqlQueryable,
  scope: TrustedExecutionScope,
  start: Date
) {
  const result = await db.query<{ spent_cents: string | number | null }>(
    `SELECT COALESCE(SUM(actual_cost_cents),0) AS spent_cents
     FROM ai_call_audits
     WHERE portfolio_id=$1
       AND company_id=$2
       AND recorded_at >= $3`,
    [scope.portfolioId, scope.companyId, start.toISOString()]
  );
  const value = Number(result.rows[0]?.spent_cents ?? 0);
  return Number.isFinite(value) ? Number(value.toFixed(6)) : 0;
}

export async function recordAIGatewayCanarySuccess(input: {
  db: SqlQueryable;
  scope: TrustedExecutionScope;
  observedAt: string;
}) {
  const timestamp = new Date(input.observedAt);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("Canary observedAt must be a valid timestamp");
  }
  const id = `canary:${input.scope.portfolioId}:${input.scope.companyId}`;
  const payload = {
    observedAt: timestamp.toISOString(),
    environment: input.scope.environment
  };

  await runWithPostgresTenantScope(input.scope, () => input.db.query(
    `INSERT INTO control_plane_entities
      (entity_type,id,portfolio_id,company_id,version,updated_at,payload)
     VALUES($1,$2,$3,$4,1,$5,$6::jsonb)
     ON CONFLICT (entity_type,id) DO UPDATE
       SET version=control_plane_entities.version+1,
           updated_at=EXCLUDED.updated_at,
           payload=EXCLUDED.payload
       WHERE control_plane_entities.portfolio_id=EXCLUDED.portfolio_id
         AND control_plane_entities.company_id=EXCLUDED.company_id`,
    [
      CANARY_ENTITY_TYPE,
      id,
      input.scope.portfolioId,
      input.scope.companyId,
      timestamp.toISOString(),
      JSON.stringify(payload)
    ]
  ));
}

export async function readOwnerAIGatewayHealth(
  scope: TrustedExecutionScope,
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: { db?: SqlQueryable; now?: Date } = {}
): Promise<AIGatewayOwnerHealth> {
  const now = options.now ?? new Date();
  const db = options.db ?? getPostgresRuntimeFromEnv(env).database;
  const configured = isAIGatewayConfigured(env);

  let policyVersion: string | null = null;
  let primaryProfile: ModelProfile | undefined;
  let fallbackProfile: ModelProfile | undefined;
  let configValid = false;

  if (configured) {
    try {
      const config = readAIGatewayRuntimeConfig(env);
      policyVersion = config.policy.version;
      const route = config.policy.routes.STANDARD ?? [];
      const byId = new Map(config.profiles.map((profile) => [profile.id, profile]));
      primaryProfile = route[0] ? byId.get(route[0]) : undefined;
      fallbackProfile = route[1] ? byId.get(route[1]) : undefined;
      configValid = Boolean(primaryProfile);
    } catch {
      configValid = false;
    }
  }

  return runWithPostgresTenantScope(scope, async () => {
    const [
      canaryAt,
      errorClass,
      primaryLastSuccess,
      fallbackLastSuccess,
      spentCents
    ] = await Promise.all([
      lastSuccessfulCanary(db, scope),
      recentErrorClass(
        db,
        scope,
        new Date(now.getTime() - 24 * 60 * 60_000)
      ),
      latestProfileSuccess(db, scope, primaryProfile?.id),
      latestProfileSuccess(db, scope, fallbackProfile?.id),
      monthlySpend(db, scope, monthStart(now))
    ]);

    const limitCents = monthlyBudgetCents(env);
    const remainingCents = limitCents === null
      ? null
      : Number(Math.max(0, limitCents - spentCents).toFixed(6));
    const budgetStatus = limitCents === null
      ? "unknown" as const
      : spentCents >= limitCents
        ? "exhausted" as const
        : spentCents >= limitCents * 0.8
          ? "near-limit" as const
          : "healthy" as const;

    const primaryAvailable = isProfileAvailable(primaryProfile, scope.environment);
    const fallbackAvailable = isProfileAvailable(fallbackProfile, scope.environment);
    const status = !configured || !configValid
      ? "not-configured" as const
      : primaryAvailable && Boolean(fallbackProfile) && fallbackAvailable
        ? "ready" as const
        : "degraded" as const;

    return {
      surfaceVersion: AI_GATEWAY_HEALTH_SURFACE_VERSION,
      configured: configured && configValid,
      status,
      activeRoutingPolicyVersion: policyVersion,
      lastSuccessfulCanaryAt: canaryAt,
      primary: {
        configured: Boolean(primaryProfile),
        available: primaryAvailable,
        lastSuccessfulCallAt: primaryLastSuccess
      },
      fallback: {
        configured: Boolean(fallbackProfile),
        available: fallbackAvailable,
        lastSuccessfulCallAt: fallbackLastSuccess
      },
      recentErrorClass: errorClass,
      budget: {
        configured: limitCents !== null,
        status: budgetStatus,
        period: periodLabel(now),
        spentCents,
        limitCents,
        remainingCents
      }
    };
  });
}
