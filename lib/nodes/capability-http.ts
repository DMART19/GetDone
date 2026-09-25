import { z } from "zod";
import {
  ControlPlaneError,
  toControlPlaneError
} from "@/lib/control-plane/errors";
import {
  createCorrelationId,
  readIdempotencyKey
} from "@/lib/control-plane/request-context";
import {
  readServerRuntimeEnvironment
} from "@/lib/control-plane/runtime-environment.server";
import {
  apiFailure,
  apiSuccess
} from "@/lib/control-plane/schemas";
import {
  RATE_LIMIT_POLICIES,
  enforceRateLimit,
  rateLimitHeaders,
  tenantRateLimitKey
} from "@/lib/security/rate-limit.server";
import {
  getNodeAgentAuthenticator
} from "@/lib/nodes/agent-runtime.server";
import {
  getNodeCapabilityAdapter
} from "@/lib/nodes/capability-runtime.server";
import {
  nodeCapabilityProfileSchema
} from "@/lib/nodes/schemas";

async function parseJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Request body must be valid JSON"
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Invalid Node capability profile payload"
    );
  }
  return parsed.data;
}

export async function handleNodeCapabilities(request: Request) {
  const correlationId = createCorrelationId();
  const environment = readServerRuntimeEnvironment();
  try {
    if (!readIdempotencyKey(request.headers)) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Idempotency-Key header is required"
      );
    }
    const principal = await getNodeAgentAuthenticator().authenticate(request);
    await enforceRateLimit(
      RATE_LIMIT_POLICIES.agentMutation,
      tenantRateLimitKey({
        portfolioId: principal.portfolioId,
        companyId: principal.companyId
      }, `capabilities:${principal.nodeId}`)
    );
    const profile = await parseJson(request, nodeCapabilityProfileSchema);
    const data = await getNodeCapabilityAdapter().submit(principal, profile);
    return Response.json(
      apiSuccess(data, { correlationId, environment }),
      {
        status: 201,
        headers: { "cache-control": "no-store" }
      }
    );
  } catch (error) {
    const normalized = toControlPlaneError(error, correlationId);
    return Response.json(
      apiFailure(normalized.code, normalized.message, {
        correlationId,
        environment
      }),
      {
        status: normalized.status,
        headers: { "cache-control": "no-store", ...rateLimitHeaders(normalized) }
      }
    );
  }
}
