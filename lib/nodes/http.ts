import { z } from "zod";
import { ControlPlaneError, toControlPlaneError } from "@/lib/control-plane/errors";
import { createCorrelationId, readIdempotencyKey } from "@/lib/control-plane/request-context";
import { readServerRuntimeEnvironment } from "@/lib/control-plane/runtime-environment.server";
import { apiFailure, apiSuccess } from "@/lib/control-plane/schemas";
import { getControlApiAdapter } from "@/lib/control-api/runtime.server";
import { getNodeEnrollmentAdapter } from "@/lib/nodes/runtime.server";
import {
  nodeAgentBootstrapSchema,
  nodeControlEnrollmentActionSchema,
  nodeControlEnrollmentCreateSchema
} from "@/lib/nodes/schemas";

function requireIdempotencyKey(request: Request) {
  const value = readIdempotencyKey(request.headers);
  if (!value) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Idempotency-Key header is required");
  }
  return value;
}

function safeId(value: string, label: string) {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} is invalid`);
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
  operation: () => Promise<T>,
  status = 200
) {
  const correlationId = createCorrelationId();
  const environment = readServerRuntimeEnvironment();
  try {
    const data = await operation();
    return Response.json(apiSuccess(data, { correlationId, environment }), {
      status,
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

async function ownerPrincipal(request: Request) {
  return getControlApiAdapter().authenticate(request);
}

export function handleListNodeEnrollments(request: Request) {
  return execute(async () =>
    getNodeEnrollmentAdapter().list(await ownerPrincipal(request))
  );
}

export function handleGetNodeEnrollment(request: Request, challengeId: string) {
  return execute(async () => {
    const value = await getNodeEnrollmentAdapter().get(
      await ownerPrincipal(request),
      safeId(challengeId, "challengeId")
    );
    if (!value) throw new ControlPlaneError("NOT_FOUND", "Node enrollment was not found");
    return value;
  });
}

export function handleCreateNodeEnrollment(request: Request) {
  return execute(async () => {
    const principal = await ownerPrincipal(request);
    const body = await parseJson(
      request,
      nodeControlEnrollmentCreateSchema,
      "Node enrollment"
    );
    return getNodeEnrollmentAdapter().create(principal, {
      ...body,
      idempotencyKey: requireIdempotencyKey(request)
    });
  }, 201);
}

export function handleNodeEnrollmentAction(request: Request, challengeId: string) {
  return execute(async () => {
    const principal = await ownerPrincipal(request);
    const body = await parseJson(
      request,
      nodeControlEnrollmentActionSchema,
      "Node enrollment action"
    );
    const adapter = getNodeEnrollmentAdapter();
    const id = safeId(challengeId, "challengeId");
    const idempotencyKey = requireIdempotencyKey(request);

    switch (body.action) {
      case "owner-action":
        return adapter.ownerAction(
          principal,
          id,
          body.evidenceId!,
          idempotencyKey
        );
      case "cancel":
        return adapter.cancel(principal, id, idempotencyKey);
      case "expire":
        return adapter.expire(principal, id, idempotencyKey);
    }
  });
}

export function handleAgentNodeEnrollment(request: Request) {
  return execute(async () => {
    const body = await parseJson(
      request,
      nodeAgentBootstrapSchema,
      "Node Agent enrollment"
    );
    return getNodeEnrollmentAdapter().enrollAgent(body);
  }, 201);
}
