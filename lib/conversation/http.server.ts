import type { OwnerIntentRecord } from "@/lib/control-api/contracts";
import { z } from "zod";
import { businessSession } from "@/lib/businesses/runtime.server";
import { listBusinesses } from "@/lib/businesses/repository";
import { getControlApiAdapter } from "@/lib/control-api/runtime.server";
import { PostgresOwnerIntentStore } from "@/lib/persistence/postgres/control-api-stores";
import { getAuthPostgresDatabaseFromEnv } from "@/lib/persistence/postgres/auth-runtime.server";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";
import { ControlPlaneError, toControlPlaneError } from "@/lib/control-plane/errors";
import { apiFailure, apiSuccess } from "@/lib/control-plane/schemas";
import { readServerRuntimeEnvironment } from "@/lib/control-plane/runtime-environment.server";
import { RATE_LIMIT_POLICIES, enforceRateLimit, rateLimitHeaders, tenantRateLimitKey } from "@/lib/security/rate-limit.server";
import { redactTelemetryText } from "@/lib/observability/telemetry";
import { semanticInterpretation } from "./semantic.server";
import { scopedRequest, submitThreadTurn, restoreState, type ThreadTurn } from "./thread-service";
import type { RegisteredBusiness } from "./understanding";

const postSchema = z.object({ message: z.string().trim().min(1).max(20_000), threadId: z.string().uuid(), channel: z.literal("chat").optional() }).strict();
const profileSchema = z.object({ aliases: z.array(z.string().min(1).max(200)).max(20).default([]), description: z.string().max(1000).optional() });
export async function handleThread(request: Request) {
  const correlationId = crypto.randomUUID();
  const environment = readServerRuntimeEnvironment();
  try {
    const { db, session } = await businessSession(request);
    const adapter = getControlApiAdapter();
    const store = new PostgresOwnerIntentStore(db);
    // The membership catalog is pre-tenant identity data. Reading it through
    // the business runtime role would return no rows under correct RLS.
    const businesses: RegisteredBusiness[] = await listBusinesses(getAuthPostgresDatabaseFromEnv(), session.userId);
    if (!businesses.length) throw new ControlPlaneError("FORBIDDEN", "Register a business before starting a conversation");
    const posted = request.method === "POST" ? postSchema.safeParse(await request.json().catch(() => null)) : undefined;
    if (posted && !posted.success) throw new ControlPlaneError("VALIDATION_FAILED", "Invalid conversation message");
    const requestedThread = posted?.success ? posted.data.threadId : new URL(request.url).searchParams.get("threadId") ?? undefined;
    if (requestedThread && !z.string().uuid().safeParse(requestedThread).success) throw new ControlPlaneError("VALIDATION_FAILED", "Invalid conversation ID");
    const respond = async () => {
      const records: OwnerIntentRecord[] = [];
      for (const business of businesses) {
        // Refresh membership authorization on every request and every business.
        await adapter.authenticate(scopedRequest(request, business));
        await runWithPostgresTenantScope({ portfolioId: business.portfolioId, companyId: business.id }, async () => {
          const profiles = await db.query<{ payload: unknown }>(`SELECT payload FROM control_plane_entities
            WHERE portfolio_id=$1 AND company_id=$2 AND entity_type='business-profile'
            AND payload->>'environment'=$3 AND LOWER(COALESCE(payload->>'sensitivity',payload->>'dataClass',payload->'scope'->>'dataClass','internal')) IN ('public','internal')
            ORDER BY updated_at DESC LIMIT 1`, [business.portfolioId, business.id, environment]);
          const profile = profileSchema.safeParse(profiles.rows[0]?.payload);
          if (profile.success) Object.assign(business, profile.data);
          records.push(...await store.listConversation(business.portfolioId, business.id, session.userId, environment, requestedThread));
        });
      }
      records.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
      const threadId = requestedThread ?? records.at(-1)?.threadId ?? crypto.randomUUID();
      const turns: ThreadTurn[] = [];
      for (const record of records.filter(r => r.threadId === threadId)) {
        const business = businesses.find(b => b.id === record.companyId && b.portfolioId === record.portfolioId)!;
        const principal = await adapter.authenticate(scopedRequest(request, business));
        if (!adapter.getOwnerIntentStatus) throw new ControlPlaneError("UNAVAILABLE", "Conversation status is not connected");
        turns.push({ record, status: await adapter.getOwnerIntentStatus(principal, record.id) });
      }
      let data: unknown = { threadId, turns, state: restoreState(turns), businesses };
      if (posted?.success) {
        const base = businesses.find(b => b.portfolioId === restoreState(turns).activeBusiness?.portfolioId) ?? businesses[0];
        const principal = await adapter.authenticate(scopedRequest(request, base));
        if (principal.role !== "owner") throw new ControlPlaneError("FORBIDDEN", "Conversation submission requires the owner role");
        await enforceRateLimit(RATE_LIMIT_POLICIES.ownerIntent, tenantRateLimitKey(principal.scope, "owner-intent"));
        const key = request.headers.get("idempotency-key");
        if (!key || key.length > 160) throw new ControlPlaneError("VALIDATION_FAILED", "Idempotency-Key is required and must be bounded");
        data = await submitThreadTurn({ request, message: redactTelemetryText(posted.data.message), threadId, turns, businesses, adapter,
          idempotencyKey: key, correlationId,
          model: (message, state) => runWithPostgresTenantScope(principal.scope, () => semanticInterpretation(db, principal, message, state)) });
      }
      return Response.json(apiSuccess(data, { correlationId, environment }), { status: posted ? 202 : 200, headers: { "cache-control": "no-store" } });
    };
    if (posted?.success) {
      return await db.transaction(async client => {
        const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked", [`chat:${session.userId}:${posted.data.threadId}`]);
        if (!lock.rows[0]?.locked) throw new ControlPlaneError("CONFLICT", "Another message is being processed in this conversation. Retry after it completes.");
        return respond();
      });
    }
    return await respond();
  } catch (error) {
    const normalized = toControlPlaneError(error, correlationId);
    return Response.json(apiFailure(normalized.code, normalized.message, { correlationId, environment }),
      { status: normalized.status, headers: { "cache-control": "no-store", ...rateLimitHeaders(normalized) } });
  }
}
