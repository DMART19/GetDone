import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import {
  assertAuthorizedBusinessActionRequest,
  type AuthorizedBusinessActionRequest,
  type BusinessActionExecutionContext,
  type BusinessActionCredentialRequirement,
  type BusinessActionRetryClass
} from "@/lib/execution/adapters/business-action";

export type CredentialReference = `env:${string}`;

export const ORDINARY_INTEGRATION_RETRY_TAXONOMY: readonly BusinessActionRetryClass[] = Object.freeze([
  "none",
  "transport",
  "timeout",
  "rate-limit",
  "provider-4xx",
  "provider-5xx",
  "malformed-response",
  "verification-pending"
]);


export interface BusinessActionAdapterDeclaration {
  capability: string;
  provider: string;
  credentialMode: "brokered-lease";
  minimumScopes: readonly string[];
  verificationScopes?: readonly string[];
  timeoutMs: Readonly<{ min: number; max: number }>;
  idempotency: "required";
  retryTaxonomy: readonly BusinessActionRetryClass[];
  providerOperationId: "required";
  statusResume: "supported" | "not-supported";
  maxResponseBytes: number;
  auditEvidence: "hashed-provider-evidence";
  verificationStrategy:
    | "provider-acceptance-only"
    | "provider-object-read"
    | "configured-independent-endpoint";
  cancellation: "supported" | "not-supported" | "configured";
  tenantEnvironmentBinding: true;
  truthSemantics: "provider-acceptance-is-not-business-truth";
}

const credentialReferencePattern = /^env:[A-Z][A-Z0-9_]*$/;
const providerOperationPattern = /^[A-Za-z0-9][A-Za-z0-9._:@+=-]{0,499}$/;

export function assertCredentialReference(value: string, label = "credential reference"): CredentialReference {
  if (!credentialReferencePattern.test(value)) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      `${label} must be a server-side env:VARIABLE reference`
    );
  }
  return value as CredentialReference;
}

export function resolveCredentialReference(
  value: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  label = "credential"
) {
  const reference = assertCredentialReference(value, label);
  const variable = reference.slice(4);
  const secret = env[variable]?.trim();
  if (!secret) {
    throw new ControlPlaneError("UNAVAILABLE", `${label} is unavailable`);
  }
  return secret;
}

export function requireBrokeredCredential(
  context: BusinessActionExecutionContext | undefined,
  requirement: BusinessActionCredentialRequirement,
  capability: string
) {
  const credential = context?.credential;
  if (
    !credential
    || credential.providerId !== requirement.providerId
    || credential.capability !== capability
    || Date.parse(credential.expiresAt) <= Date.now()
    || !requirement.requiredScopes.every((scope) => credential.grantedScopes.includes(scope))
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Adapter requires valid short-lived credential material from the governed credential broker"
    );
  }
  return credential.material;
}

export function assertAdapterRequest(
  request: AuthorizedBusinessActionRequest,
  declaration: BusinessActionAdapterDeclaration,
  binding: {
    companyId: string;
    environment: TrustedExecutionScope["environment"];
  }
) {
  assertAuthorizedBusinessActionRequest(request);
  if (request.capability !== declaration.capability) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      `${declaration.provider} adapter only accepts ${declaration.capability}`
    );
  }
  if (
    request.scope.companyId !== binding.companyId
    || request.scope.environment !== binding.environment
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      `${declaration.provider} integration is outside the authoritative tenant/environment binding`
    );
  }
  if (
    request.timeoutMs < declaration.timeoutMs.min
    || request.timeoutMs > declaration.timeoutMs.max
  ) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      `${declaration.provider} timeout is outside the adapter policy`
    );
  }
  return request;
}

export function assertProviderOperationId(value: string) {
  const normalized = value.trim();
  if (!providerOperationPattern.test(normalized)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Provider operation ID is malformed");
  }
  return normalized;
}

export async function readBoundedResponseBody(response: Response, limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5_000_000) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Response limit must be 1-5000000 bytes");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > limit) {
      await response.body?.cancel();
      throw new ControlPlaneError("UNAVAILABLE", "Provider response exceeds configured size limit");
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new ControlPlaneError("UNAVAILABLE", "Provider response exceeds configured size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function readBoundedJson(response: Response, limit: number): Promise<unknown> {
  const text = await readBoundedResponseBody(response, limit);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ControlPlaneError("UNAVAILABLE", "Provider returned malformed JSON");
  }
}

export function classifyHttpFailure(status: number): {
  retryable: boolean;
  retryClass: BusinessActionRetryClass;
  resultStatus: "rejected" | "failed";
} {
  if (status === 408) {
    return { retryable: true, retryClass: "timeout", resultStatus: "failed" };
  }
  if (status === 425 || status === 429) {
    return { retryable: true, retryClass: "rate-limit", resultStatus: "failed" };
  }
  if (status >= 500) {
    return { retryable: true, retryClass: "provider-5xx", resultStatus: "failed" };
  }
  return { retryable: false, retryClass: "provider-4xx", resultStatus: "rejected" };
}

export function providerRequestHeaders(input: {
  request: AuthorizedBusinessActionRequest;
  credential?: string;
  contentType?: string;
}) {
  const headers: Record<string, string> = {
    "idempotency-key": input.request.idempotencyKey,
    "x-getdone-job-id": input.request.jobId,
    "x-getdone-request-id": input.request.id
  };
  if (input.contentType) headers["content-type"] = input.contentType;
  if (input.credential) headers.authorization = `Bearer ${input.credential}`;
  return headers;
}

export function interpolateOperationUrl(template: string, providerOperationId: string) {
  const url = template.replace(
    "{providerOperationId}",
    encodeURIComponent(assertProviderOperationId(providerOperationId))
  );
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Configured provider URL must be credential-free HTTPS");
  }
  return parsed.toString();
}
