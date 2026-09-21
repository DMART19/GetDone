import { z } from "zod";
import { ControlPlaneError, toControlPlaneError } from "@/lib/control-plane/errors";
import { createCorrelationId, readIdempotencyKey } from "@/lib/control-plane/request-context";
import { readServerRuntimeEnvironment } from "@/lib/control-plane/runtime-environment.server";
import { apiFailure, apiSuccess } from "@/lib/control-plane/schemas";
import { getControlApiAdapter } from "@/lib/control-api/runtime.server";

const ownerIntentSchema = z.object({
  message: z.string().trim().min(1).max(20_000),
  channel: z.enum(["chat", "api"]).optional()
});

const decisionMutationSchema = z.object({
  action: z.enum(["approve", "modify", "reject"]),
  note: z.string().max(2_000).optional()
});

const resourceDiscoverySchema = z.object({
  id: z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  type: z.enum(["compute", "gpu", "storage", "network", "cloud", "partner", "other"]),
  providerId: z.string().min(1).max(160).optional(),
  poolId: z.string().min(1).max(160).optional(),
  capabilityNames: z.array(z.string().min(1).max(160)).max(100).optional(),
  failureDomainIds: z.array(z.string().min(1).max(160)).max(100).optional(),
  credentialBindingIds: z.array(z.string().min(1).max(160)).max(100).optional(),
  policyBindingIds: z.array(z.string().min(1).max(160)).max(100).optional(),
  region: z.string().min(1).max(160).optional(),
  architecture: z.string().min(1).max(160).optional()
});

const resourceEnrollmentStartSchema = z.object({
  id: z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  requestedType: z.enum(["compute", "gpu", "storage", "network", "cloud", "partner", "other"]),
  ownerActionRequired: z.boolean(),
  ownerActionDescription: z.string().min(1).max(2_000).optional(),
  challengeToken: z.string().min(16).max(512),
  challengeExpiresAt: z.string().datetime()
});

const resourceEnrollmentActionSchema = z.object({
  action: z.enum([
    "create", "owner-action", "authenticate", "discover", "profile", "validate",
    "test", "register", "ready", "fail", "cancel", "expire", "restart"
  ]),
  evidenceId: z.string().min(1).max(160).optional(),
  challengeToken: z.string().min(16).max(512).optional(),
  authenticatedAt: z.string().datetime().optional(),
  resourceId: z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  reason: z.string().min(1).max(2_000).optional(),
  challengeExpiresAt: z.string().datetime().optional(),
  restartedAt: z.string().datetime().optional()
});

function safeId(value: string, label: string) {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} is invalid`);
  }
  return value;
}

function requireIdempotencyKey(request: Request) {
  const value = readIdempotencyKey(request.headers);
  if (!value) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Idempotency-Key header is required");
  }
  return value;
}

async function jsonBody(request: Request) {
  try {
    return await request.json();
  } catch {
    throw new ControlPlaneError("VALIDATION_FAILED", "Request body must be valid JSON");
  }
}

async function parseJson<T>(request: Request, schema: z.ZodType<T>, label: string): Promise<T> {
  const parsed = schema.safeParse(await jsonBody(request));
  if (!parsed.success) {
    throw new ControlPlaneError("VALIDATION_FAILED", `Invalid ${label} payload`);
  }
  return parsed.data;
}

async function execute<T>(
  operation: (adapter: ReturnType<typeof getControlApiAdapter>) => Promise<T>,
  options: { status?: number } = {}
) {
  const correlationId = createCorrelationId();
  const environment = readServerRuntimeEnvironment();
  try {
    const adapter = getControlApiAdapter();
    const data = await operation(adapter);
    return Response.json(apiSuccess(data, { correlationId, environment }), {
      status: options.status ?? 200,
      headers: { "cache-control": "no-store" }
    });
  } catch (error) {
    const normalized = toControlPlaneError(error, correlationId);
    return Response.json(
      apiFailure(normalized.code, normalized.message, { correlationId, environment }),
      {
        status: normalized.status,
        headers: { "cache-control": "no-store" }
      }
    );
  }
}


export function handleControlHealth() {
  return execute((adapter) => adapter.health());
}

export function handleOwnerIntent(request: Request) {
  return execute(async (adapter) => {
    const actor = await adapter.authenticate(request);
    const input = await parseJson(request, ownerIntentSchema, "owner intent");
    return adapter.submitOwnerIntent(actor, input, requireIdempotencyKey(request));
  }, { status: 202 });
}

export function handleListDecisions(request: Request) {
  return execute(async (adapter) => adapter.listDecisions(await adapter.authenticate(request)));
}

export function handleGetDecision(request: Request, decisionId: string) {
  return execute(async (adapter) => {
    const value = await adapter.getDecision(await adapter.authenticate(request), safeId(decisionId, "decisionId"));
    if (!value) throw new ControlPlaneError("NOT_FOUND", "Decision was not found");
    return value;
  });
}

export function handleMutateDecision(request: Request, decisionId: string) {
  return execute(async (adapter) => {
    const actor = await adapter.authenticate(request);
    const body = await parseJson(request, decisionMutationSchema, "decision mutation");
    return adapter.mutateDecision(actor, {
      decisionId: safeId(decisionId, "decisionId"),
      action: body.action,
      note: body.note,
      idempotencyKey: requireIdempotencyKey(request)
    });
  });
}

export function handleListResources(request: Request) {
  return execute(async (adapter) => adapter.listResources(await adapter.authenticate(request)));
}

export function handleGetResource(request: Request, resourceId: string) {
  return execute(async (adapter) => {
    const value = await adapter.getResource(await adapter.authenticate(request), safeId(resourceId, "resourceId"));
    if (!value) throw new ControlPlaneError("NOT_FOUND", "Resource was not found");
    return value;
  });
}

export function handleDiscoverResource(request: Request) {
  return execute(async (adapter) => {
    const actor = await adapter.authenticate(request);
    const body = await parseJson(request, resourceDiscoverySchema, "resource discovery");
    return adapter.discoverResource(actor, {
      ...body,
      idempotencyKey: requireIdempotencyKey(request)
    });
  }, { status: 201 });
}

export function handleListResourceEnrollments(request: Request) {
  return execute(async (adapter) =>
    adapter.listResourceEnrollments(await adapter.authenticate(request))
  );
}

export function handleGetResourceEnrollment(request: Request, enrollmentId: string) {
  return execute(async (adapter) => {
    const value = await adapter.getResourceEnrollment(
      await adapter.authenticate(request),
      safeId(enrollmentId, "enrollmentId")
    );
    if (!value) throw new ControlPlaneError("NOT_FOUND", "Resource enrollment was not found");
    return value;
  });
}

export function handleStartResourceEnrollment(request: Request) {
  return execute(async (adapter) => {
    const actor = await adapter.authenticate(request);
    const body = await parseJson(request, resourceEnrollmentStartSchema, "resource enrollment");
    return adapter.startResourceEnrollment(actor, {
      ...body,
      idempotencyKey: requireIdempotencyKey(request)
    });
  }, { status: 201 });
}

export function handleAdvanceResourceEnrollment(request: Request, enrollmentId: string) {
  return execute(async (adapter) => {
    const actor = await adapter.authenticate(request);
    const body = await parseJson(request, resourceEnrollmentActionSchema, "resource enrollment action");
    return adapter.advanceResourceEnrollment(
      actor,
      safeId(enrollmentId, "enrollmentId"),
      { ...body, idempotencyKey: requireIdempotencyKey(request) }
    );
  });
}

export function handleListJobs(request: Request) {
  return execute(async (adapter) => adapter.listJobs(await adapter.authenticate(request)));
}

export function handleGetJob(request: Request, jobId: string) {
  return execute(async (adapter) => {
    const value = await adapter.getJob(await adapter.authenticate(request), safeId(jobId, "jobId"));
    if (!value) throw new ControlPlaneError("NOT_FOUND", "Job was not found");
    return value;
  });
}

export function handleGetJobResult(request: Request, jobId: string) {
  return execute(async (adapter) => {
    const value = await adapter.getJobResult(await adapter.authenticate(request), safeId(jobId, "jobId"));
    if (!value) throw new ControlPlaneError("NOT_FOUND", "Job result was not found");
    return value;
  });
}

export function handleListVerifications(request: Request) {
  return execute(async (adapter) => adapter.listVerifications(await adapter.authenticate(request)));
}

export function handleGetVerification(request: Request, verificationId: string) {
  return execute(async (adapter) => {
    const value = await adapter.getVerification(
      await adapter.authenticate(request),
      safeId(verificationId, "verificationId")
    );
    if (!value) throw new ControlPlaneError("NOT_FOUND", "Verification was not found");
    return value;
  });
}
