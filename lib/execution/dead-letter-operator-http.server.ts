import { z } from "zod";
import { ControlPlaneError, toControlPlaneError } from "@/lib/control-plane/errors";
import { createCorrelationId, readIdempotencyKey } from "@/lib/control-plane/request-context";
import { readServerRuntimeEnvironment } from "@/lib/control-plane/runtime-environment.server";
import { apiFailure, apiSuccess } from "@/lib/control-plane/schemas";
import { getControlApiAdapter } from "@/lib/control-api/runtime.server";
import { getDeadLetterOperatorServiceFromEnv } from "@/lib/execution/dead-letter-operator.server";

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("dismiss"),
    reason: z.string().trim().min(1).max(2_000)
  }).strict(),
  z.object({
    action: z.literal("cancel"),
    reason: z.string().trim().min(1).max(2_000)
  }).strict(),
  z.object({
    action: z.literal("retry"),
    reason: z.string().trim().min(1).max(2_000),
    replacementJobId: z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/),
    credentialLeaseId: z.string().min(1).max(512).optional()
  }).strict()
]);

function safeId(value: string) {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "jobId is invalid");
  }
  return value;
}

function idempotencyKey(request: Request) {
  const value = readIdempotencyKey(request.headers);
  if (!value) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Idempotency-Key header is required");
  }
  return value;
}

async function body(request: Request) {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ControlPlaneError("VALIDATION_FAILED", "Request body must be valid JSON");
  }
  const parsed = actionSchema.safeParse(value);
  if (!parsed.success) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Invalid dead-letter operator action");
  }
  return parsed.data;
}

async function execute<T>(operation: () => Promise<T>, status = 200) {
  const correlationId = createCorrelationId();
  const environment = readServerRuntimeEnvironment();
  try {
    return Response.json(apiSuccess(await operation(), { correlationId, environment }), {
      status,
      headers: { "cache-control": "no-store" }
    });
  } catch (error) {
    const normalized = toControlPlaneError(error, correlationId);
    return Response.json(
      apiFailure(normalized.code, normalized.message, { correlationId, environment }),
      { status: normalized.status, headers: { "cache-control": "no-store" } }
    );
  }
}

async function principal(request: Request) {
  return getControlApiAdapter().authenticate(request);
}

export function handleListDeadLetters(request: Request) {
  return execute(async () =>
    getDeadLetterOperatorServiceFromEnv().list(await principal(request))
  );
}

export function handleGetDeadLetter(request: Request, jobId: string) {
  return execute(async () => {
    const value = await getDeadLetterOperatorServiceFromEnv().get(
      await principal(request),
      safeId(jobId)
    );
    if (!value) throw new ControlPlaneError("NOT_FOUND", "Dead-lettered Job was not found");
    return value;
  });
}

export function handleDeadLetterAction(request: Request, jobId: string) {
  return execute(async () => {
    const [actor, input] = await Promise.all([principal(request), body(request)]);
    return getDeadLetterOperatorServiceFromEnv().act(actor, safeId(jobId), {
      ...input,
      idempotencyKey: idempotencyKey(request)
    });
  }, 202);
}
