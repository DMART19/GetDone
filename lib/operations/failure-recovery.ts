/** Advisory recovery classification: never replays an external side effect. */
export type RecoveryRecommendation = "retry_read_only" | "reconcile_first" | "request_owner" | "stop";
export interface FailureContext {
  code: string;
  operation: "read" | "write" | "unknown";
  authorizationValid: boolean;
  verifiedFailure: boolean;
  attempts: number;
  maxAttempts: number;
}
const retryable = new Set(["UNAVAILABLE", "RATE_LIMITED", "TIMEOUT", "TRANSIENT_NETWORK"]);
export function recommendFailureRecovery(input: FailureContext): RecoveryRecommendation {
  if (!input.authorizationValid || !input.verifiedFailure) return "request_owner";
  if (!Number.isInteger(input.attempts) || !Number.isInteger(input.maxAttempts)
    || input.attempts < 0 || input.maxAttempts < 1 || input.attempts >= input.maxAttempts) return "stop";
  if (input.operation !== "read") return "reconcile_first";
  return retryable.has(input.code) ? "retry_read_only" : "request_owner";
}
