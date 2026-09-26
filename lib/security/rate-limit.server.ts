import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";

export interface RateLimitPolicy {
  id: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: string;
  retryAfterSeconds: number;
}

interface RateLimitRow {
  request_count: string | number;
  window_expires_at: Date | string;
}

export const RATE_LIMIT_POLICIES = Object.freeze({
  authBegin: { id: "auth.sign-in.begin", limit: 30, windowSeconds: 60 },
  authVerify: { id: "auth.sign-in.verify", limit: 45, windowSeconds: 60 },
  stepUpBegin: { id: "auth.step-up.begin", limit: 30, windowSeconds: 60 },
  stepUpVerify: { id: "auth.step-up.verify", limit: 45, windowSeconds: 60 },
  ownerIntent: { id: "owner.intent", limit: 60, windowSeconds: 60 },
  decisionMutation: { id: "decision.mutation", limit: 60, windowSeconds: 60 },
  enrollmentMutation: { id: "enrollment.mutation", limit: 60, windowSeconds: 60 },
  integrationMutation: { id: "integration.mutation", limit: 60, windowSeconds: 60 },
  workerRun: { id: "worker.run-once", limit: 30, windowSeconds: 60 },
  workerHealth: { id: "worker.health", limit: 60, windowSeconds: 60 },
  agentEnrollment: { id: "agent.enrollment", limit: 20, windowSeconds: 60 },
  agentAuthentication: { id: "agent.authentication", limit: 60, windowSeconds: 60 },
  agentMutation: { id: "agent.mutation", limit: 120, windowSeconds: 60 }
} satisfies Record<string, RateLimitPolicy>);

function positivePolicy(policy: RateLimitPolicy) {
  if (
    !policy.id.trim()
    || !Number.isInteger(policy.limit)
    || policy.limit <= 0
    || !Number.isInteger(policy.windowSeconds)
    || policy.windowSeconds <= 0
  ) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Rate limit policy is invalid");
  }
}

export class PostgresRateLimiter {
  constructor(private readonly database: SqlQueryable) {}

  async consume(
    policy: RateLimitPolicy,
    keyParts: readonly string[],
    now = new Date()
  ): Promise<RateLimitDecision> {
    positivePolicy(policy);
    const normalized = keyParts.map((part) => part.trim()).filter(Boolean);
    if (normalized.length === 0) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Rate limit key is required");
    }
    const keyHash = sha256Hex({
      policy: policy.id,
      keyParts: normalized
    });
    const result = await this.database.query<RateLimitRow>(
      `INSERT INTO rate_limit_buckets
        (policy_id,bucket_key_hash,window_started_at,window_expires_at,request_count,updated_at)
       VALUES($1,$2,$3,$3::timestamptz + ($4::int * interval '1 second'),1,$3)
       ON CONFLICT(policy_id,bucket_key_hash)
       DO UPDATE SET
         request_count = CASE
           WHEN rate_limit_buckets.window_expires_at <= $3 THEN 1
           ELSE rate_limit_buckets.request_count + 1
         END,
         window_started_at = CASE
           WHEN rate_limit_buckets.window_expires_at <= $3 THEN $3
           ELSE rate_limit_buckets.window_started_at
         END,
         window_expires_at = CASE
           WHEN rate_limit_buckets.window_expires_at <= $3
             THEN $3::timestamptz + ($4::int * interval '1 second')
           ELSE rate_limit_buckets.window_expires_at
         END,
         updated_at=$3
       RETURNING request_count,window_expires_at`,
      [policy.id, keyHash, now.toISOString(), policy.windowSeconds]
    );
    const row = result.rows[0];
    if (!row) {
      throw new ControlPlaneError("UNAVAILABLE", "Rate limit persistence did not return a bucket");
    }
    const count = Number(row.request_count);
    const resetAt = row.window_expires_at instanceof Date
      ? row.window_expires_at.toISOString()
      : String(row.window_expires_at);
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((Date.parse(resetAt) - now.getTime()) / 1000)
    );
    return Object.freeze({
      allowed: count <= policy.limit,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - count),
      resetAt,
      retryAfterSeconds
    });
  }
}

export function clientNetworkIdentity(request: Request) {
  const direct = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-real-ip");
  if (direct?.trim()) return direct.trim();
  const forwarded = request.headers.get("x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  return forwarded || "unknown-client";
}

export function requestCredentialFingerprint(request: Request) {
  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization) return "no-authorization";
  return "authorization:" + sha256Hex(authorization);
}

export function tenantRateLimitKey(input: {
  portfolioId: string;
  companyId: string;
  userId?: string;
  sessionId?: string;
}, suffix?: string) {
  return [
    "tenant",
    input.portfolioId,
    input.companyId,
    input.userId ?? "no-user",
    input.sessionId ?? "no-session",
    suffix ?? "default"
  ];
}

export async function enforceRateLimit(
  policy: RateLimitPolicy,
  keyParts: readonly string[],
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    database?: SqlQueryable;
    now?: Date;
  } = {}
) {
  const env = options.env ?? process.env;
  if (
    env.GETDONE_RUNTIME_ENV === "development"
    && env.GETDONE_RATE_LIMIT_DEVELOPMENT !== "true"
  ) {
    return Object.freeze({
      allowed: true,
      limit: policy.limit,
      remaining: policy.limit,
      resetAt: new Date((options.now ?? new Date()).getTime() + policy.windowSeconds * 1000).toISOString(),
      retryAfterSeconds: policy.windowSeconds
    });
  }
  const database = options.database ?? getPostgresRuntimeFromEnv(env).database;
  const decision = await new PostgresRateLimiter(database).consume(
    policy,
    keyParts,
    options.now
  );
  if (!decision.allowed) {
    throw new ControlPlaneError(
      "RATE_LIMITED",
      "Too many requests; retry after the rate limit window resets",
      { details: { rateLimit: decision } }
    );
  }
  return decision;
}

export function rateLimitHeaders(error: unknown): Record<string, string> {
  if (!(error instanceof ControlPlaneError) || error.code !== "RATE_LIMITED") {
    return {};
  }
  const rateLimit = error.details?.rateLimit as RateLimitDecision | undefined;
  if (!rateLimit) return {};
  return {
    "retry-after": String(rateLimit.retryAfterSeconds),
    "ratelimit-limit": String(rateLimit.limit),
    "ratelimit-remaining": String(rateLimit.remaining),
    "ratelimit-reset": String(Math.ceil(Date.parse(rateLimit.resetAt) / 1000))
  };
}
