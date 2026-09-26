import { z } from "zod";
import { readWebAuthnServerConfig } from "@/lib/auth/webauthn-config";
import { PostgresPasskeySignInService } from "@/lib/auth/postgres-sign-in";
import { ControlPlaneError, toControlPlaneError } from "@/lib/control-plane/errors";
import { createCorrelationId } from "@/lib/control-plane/request-context";
import { readServerRuntimeEnvironment } from "@/lib/control-plane/runtime-environment.server";
import { apiFailure, apiSuccess } from "@/lib/control-plane/schemas";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";

const beginSchema = z.object({
  userId: z.string().min(1).max(200)
});

const assertionSchema = z.object({
  id: z.string().min(1).max(2048),
  type: z.literal("public-key").optional(),
  response: z.object({
    clientDataJSON: z.string().min(1).max(32_768),
    authenticatorData: z.string().min(1).max(8_192),
    signature: z.string().min(1).max(8_192),
    userHandle: z.string().max(4096).nullable().optional()
  })
});

const verifySchema = z.object({
  challengeId: z.string().uuid(),
  credential: assertionSchema
});

async function json<T>(request: Request, schema: z.ZodType<T>, label: string) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ControlPlaneError("VALIDATION_FAILED", "Request body must be valid JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ControlPlaneError("VALIDATION_FAILED", `Invalid ${label} payload`);
  }
  return parsed.data;
}

function service(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  const runtime = getPostgresRuntimeFromEnv(env);
  const config = readWebAuthnServerConfig(env);
  return {
    service: new PostgresPasskeySignInService(runtime.database, config),
    config
  };
}

async function execute<T>(
  operation: () => Promise<{ data: T; headers?: Record<string, string> }>,
  status = 200
) {
  const correlationId = createCorrelationId();
  const environment = readServerRuntimeEnvironment();
  try {
    const result = await operation();
    return Response.json(apiSuccess(result.data, { correlationId, environment }), {
      status,
      headers: {
        "cache-control": "no-store",
        ...(result.headers ?? {})
      }
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

export function handleBeginPasskeySignIn(request: Request) {
  return execute(async () => {
    const input = await json(request, beginSchema, "passkey sign-in begin");
    const auth = service();
    return { data: await auth.service.begin(input.userId) };
  }, 201);
}

export function handleVerifyPasskeySignIn(request: Request) {
  return execute(async () => {
    const input = await json(request, verifySchema, "passkey sign-in verification");
    const auth = service();
    const result = await auth.service.verify(input.challengeId, input.credential);
    const maxAge = Math.max(
      1,
      Math.floor((Date.parse(result.session.expiresAt) - Date.now()) / 1000)
    );
    const secureCookie = auth.config.allowedOrigins.every(
      (origin) => new URL(origin).protocol === "https:"
    );
    const cookie = [
      `${auth.config.cookieName}=${encodeURIComponent(result.token)}`,
      "Path=/",
      "HttpOnly",
      ...(secureCookie ? ["Secure"] : []),
      "SameSite=Strict",
      `Max-Age=${maxAge}`
    ].join("; ");
    return {
      data: {
        sessionId: result.session.sessionId,
        userId: result.session.userId,
        expiresAt: result.session.expiresAt
      },
      headers: { "set-cookie": cookie }
    };
  });
}
