import type { ControlPlaneErrorCode } from "@/lib/control-plane/errors";

export type ApiSuccess<T> = {
  ok: true;
  correlationId: string;
  environment: "development" | "staging" | "production";
  data: T;
};

export type ApiFailure = {
  ok: false;
  correlationId: string;
  environment: "development" | "staging" | "production";
  error: {
    code: ControlPlaneErrorCode;
    message: string;
  };
};

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

export type DecisionAction = "approve" | "modify" | "reject";

export interface DecisionActionRequest {
  decisionId: string;
  action: DecisionAction;
  note?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireId(value: unknown, field: string) {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new TypeError(`${field} must be a safe identifier`);
  }
  return value;
}

export function parseDecisionActionRequest(value: unknown): DecisionActionRequest {
  if (!isRecord(value)) throw new TypeError("Decision action payload must be an object");

  const decisionId = requireId(value.decisionId, "decisionId");
  if (value.action !== "approve" && value.action !== "modify" && value.action !== "reject") {
    throw new TypeError("action must be approve, modify, or reject");
  }

  if (value.note !== undefined && (typeof value.note !== "string" || value.note.length > 2000)) {
    throw new TypeError("note must be a string up to 2000 characters");
  }

  return {
    decisionId,
    action: value.action,
    note: typeof value.note === "string" ? value.note : undefined
  };
}

export function apiSuccess<T>(
  data: T,
  meta: { correlationId: string; environment: ApiSuccess<T>["environment"] }
): ApiSuccess<T> {
  return { ok: true, correlationId: meta.correlationId, environment: meta.environment, data };
}

export function apiFailure(
  code: ControlPlaneErrorCode,
  message: string,
  meta: { correlationId: string; environment: ApiFailure["environment"] }
): ApiFailure {
  return { ok: false, correlationId: meta.correlationId, environment: meta.environment, error: { code, message } };
}
