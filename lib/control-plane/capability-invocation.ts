import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { CapabilityName } from "@/lib/domain/capability-schemas";
import {
  requireEnabledCapability,
  validateCapabilityInput
} from "@/lib/domain/capabilities";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export type InvocationDataClass = "public" | "internal" | "customer" | "sensitive";

export interface CapabilityInvocationEnvelope {
  scope: TrustedExecutionScope;
  capability: CapabilityName;
  parameters: unknown;
  correlationId: string;
  idempotencyKey: string;
  dataClass?: InvocationDataClass;
  authorizationRef?: string;
}

export interface BoundCapabilityInvocation<T = unknown> {
  scope: TrustedExecutionScope;
  capability: CapabilityName;
  input: T;
  correlationId: string;
  idempotencyKey: string;
  dataClass?: InvocationDataClass;
  authorizationRef?: string;
  adapterBinding: string;
}

function objectParameters(parameters: unknown) {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Capability parameters must be an object");
  }
  return { ...(parameters as Record<string, unknown>) };
}

function rejectConflictingAuthority(
  parameters: Record<string, unknown>,
  field: string,
  authoritativeValue: string | undefined
) {
  if (!(field in parameters)) return;
  const supplied = parameters[field];
  if (supplied !== authoritativeValue) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      `Capability payload attempted to override authoritative ${field}`
    );
  }
}

export function bindCapabilityInvocation<T = unknown>(
  envelope: CapabilityInvocationEnvelope
): BoundCapabilityInvocation<T> {
  if (!envelope.correlationId || !envelope.idempotencyKey) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Capability invocation requires correlation and idempotency identifiers");
  }

  const definition = requireEnabledCapability(envelope.capability);
  const parameters = objectParameters(envelope.parameters);
  const bindings = definition.authorityBindings;

  if (bindings.companyId) {
    rejectConflictingAuthority(parameters, "companyId", envelope.scope.companyId);
    delete parameters.companyId;
    parameters.companyId = envelope.scope.companyId;
  }

  if (bindings.environment) {
    rejectConflictingAuthority(parameters, "environment", envelope.scope.environment);
    delete parameters.environment;
    parameters.environment = envelope.scope.environment;
  }

  if (bindings.resourceId) {
    if (!envelope.scope.resourceId) {
      throw new ControlPlaneError("FORBIDDEN", "Capability requires trusted resource scope");
    }
    rejectConflictingAuthority(parameters, "resourceId", envelope.scope.resourceId);
    delete parameters.resourceId;
    parameters.resourceId = envelope.scope.resourceId;
  }

  if (bindings.dataClass) {
    if (!envelope.dataClass) {
      throw new ControlPlaneError("FORBIDDEN", "Capability requires authoritative data classification");
    }
    rejectConflictingAuthority(parameters, "dataClass", envelope.dataClass);
    delete parameters.dataClass;
    parameters.dataClass = envelope.dataClass;
  }

  const input = validateCapabilityInput<T>(envelope.capability, parameters);

  return Object.freeze({
    scope: envelope.scope,
    capability: envelope.capability,
    input,
    correlationId: envelope.correlationId,
    idempotencyKey: envelope.idempotencyKey,
    dataClass: envelope.dataClass,
    authorizationRef: envelope.authorizationRef,
    adapterBinding: definition.adapterBinding
  });
}
