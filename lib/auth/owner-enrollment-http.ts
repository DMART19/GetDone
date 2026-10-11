import { z } from "zod";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { OwnerEnrollmentService } from "@/lib/auth/owner-enrollment.server";
import { readWebAuthnServerConfig } from "@/lib/auth/webauthn-config";
import { ControlPlaneError, toControlPlaneError } from "@/lib/control-plane/errors";
import { createCorrelationId } from "@/lib/control-plane/request-context";
import { readServerRuntimeEnvironment } from "@/lib/control-plane/runtime-environment.server";
import { apiFailure, apiSuccess } from "@/lib/control-plane/schemas";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";
import { evaluateBrowserMutationOrigin } from "@/lib/security/browser-mutation-origin";
import { RATE_LIMIT_POLICIES, clientNetworkIdentity, enforceRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit.server";

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const beginSchema = z.object({ token: tokenSchema }).strict();
const completeSchema = beginSchema.extend({ credential: z.object({
  id: z.string().min(1).max(2048), rawId: z.string().min(1).max(2048), type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: z.string().min(1).max(8192), attestationObject: z.string().min(1).max(65536),
    transports: z.array(z.enum(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"])).optional()
  }),
  clientExtensionResults: z.object({}).passthrough(),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional()
}) });

export async function handleOwnerEnrollment(request: Request, operation: "begin" | "complete") {
  const correlationId = createCorrelationId();
  const environment = readServerRuntimeEnvironment();
  try {
    if (!evaluateBrowserMutationOrigin(request).allowed) throw new ControlPlaneError("FORBIDDEN", "Untrusted enrollment origin");
    await enforceRateLimit(RATE_LIMIT_POLICIES.authBegin, ["owner-enrollment", clientNetworkIdentity(request)]);
    // Bound the stream, including requests without Content-Length.
    const reader = request.body?.getReader();
    if (!reader) throw new ControlPlaneError("VALIDATION_FAILED", "Enrollment body is required");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length;
        if (size > 96_000) { await reader.cancel(); throw new ControlPlaneError("VALIDATION_FAILED", "Enrollment body is too large"); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new ControlPlaneError("VALIDATION_FAILED", "Enrollment body must be JSON"); }
    const runtime = getPostgresRuntimeFromEnv();
    const service = new OwnerEnrollmentService(runtime.database, readWebAuthnServerConfig(), environment);
    let data;
    if (operation === "begin") {
      const parsed = beginSchema.safeParse(body);
      if (!parsed.success) throw new ControlPlaneError("VALIDATION_FAILED", "Invalid owner invitation");
      data = await service.begin(parsed.data.token);
    } else {
      const parsed = completeSchema.safeParse(body);
      if (!parsed.success) throw new ControlPlaneError("VALIDATION_FAILED", "Invalid passkey registration");
      data = await service.complete(parsed.data.token, parsed.data.credential as RegistrationResponseJSON);
    }
    return Response.json(apiSuccess(data, { correlationId, environment }), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const normalized = toControlPlaneError(error, correlationId);
    return Response.json(apiFailure(normalized.code, normalized.message, { correlationId, environment }), {
      status: normalized.status, headers: { "cache-control": "no-store", ...rateLimitHeaders(normalized) }
    });
  }
}
