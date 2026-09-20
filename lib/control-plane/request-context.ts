import { ControlPlaneError } from "@/lib/control-plane/errors";

export type GetDoneEnvironment = "development" | "staging" | "production";

export interface TrustedActor {
  type: "user" | "system" | "worker";
  id: string;
}

export interface TrustedScope {
  userId: string;
  portfolioId?: string;
  companyId?: string;
  resourceId?: string;
}

export interface RequestContext {
  correlationId: string;
  environment: GetDoneEnvironment;
  actor: TrustedActor;
  scope: TrustedScope;
}

export function createCorrelationId() {
  return crypto.randomUUID();
}

export function parseEnvironment(value: string | undefined): GetDoneEnvironment {
  if (value === "production" || value === "staging" || value === "development") return value;
  return "development";
}

export function readIdempotencyKey(headers: Headers): string | null {
  const raw = headers.get("idempotency-key");
  if (!raw) return null;

  const value = raw.trim();
  if (value.length < 8 || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Invalid Idempotency-Key header");
  }
  return value;
}

export function createRequestContext(input: {
  actor: TrustedActor;
  scope: TrustedScope;
  environment?: string;
  correlationId?: string;
}): RequestContext {
  if (!input.actor.id || !input.scope.userId) {
    throw new ControlPlaneError("UNAUTHENTICATED", "Trusted identity is required");
  }

  return {
    correlationId: input.correlationId ?? createCorrelationId(),
    environment: parseEnvironment(input.environment),
    actor: input.actor,
    scope: { ...input.scope }
  };
}
