export type ControlPlaneErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "POLICY_BLOCKED"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "INTERNAL";

const statusByCode: Record<ControlPlaneErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  POLICY_BLOCKED: 403,
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
  INTERNAL: 500
};

export class ControlPlaneError extends Error {
  readonly code: ControlPlaneErrorCode;
  readonly status: number;
  readonly correlationId?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ControlPlaneErrorCode,
    message: string,
    options: { correlationId?: string; details?: Record<string, unknown> } = {}
  ) {
    super(message);
    this.name = "ControlPlaneError";
    this.code = code;
    this.status = statusByCode[code];
    this.correlationId = options.correlationId;
    this.details = options.details;
  }
}

export function toControlPlaneError(error: unknown, correlationId?: string) {
  if (error instanceof ControlPlaneError) return error;
  return new ControlPlaneError("INTERNAL", "Unexpected control-plane error", { correlationId });
}
