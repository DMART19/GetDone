import { createHash } from "node:crypto";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { TrustedActor } from "@/lib/control-plane/request-context";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export interface AuthoritativeCommandEnvelope<TMutation = unknown> {
  commandId: string;
  actor: TrustedActor;
  scope: TrustedExecutionScope;
  correlationId: string;
  environment: TrustedExecutionScope["environment"];
  idempotencyKey: string;
  provenance: string;
  requestedMutation: TMutation;
}

export function createCommandEnvelope<TMutation>(input: AuthoritativeCommandEnvelope<TMutation>) {
  if (!input.commandId || !input.correlationId || !input.idempotencyKey || !input.provenance) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Authoritative command identifiers and provenance are required");
  }
  if (input.environment !== input.scope.environment) {
    throw new ControlPlaneError("FORBIDDEN", "Command environment must match trusted execution scope");
  }
  return Object.freeze({
    ...input,
    scope: Object.freeze({ ...input.scope }),
    requestedMutation: Object.freeze(input.requestedMutation as object) as TMutation
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function commandFingerprint(command: AuthoritativeCommandEnvelope) {
  return createHash("sha256").update(stableJson({
    actor: command.actor,
    scope: command.scope,
    environment: command.environment,
    provenance: command.provenance,
    mutation: command.requestedMutation
  })).digest("hex");
}
