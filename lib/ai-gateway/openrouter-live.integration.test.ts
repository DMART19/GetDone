import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MvpBusinessWorkflow } from "@/lib/composition/mvp-business-workflow";
import {
  getAIGatewayFromEnv,
  resetAIGatewayRuntimeForTests
} from "@/lib/ai-gateway/runtime.server";
import { runLiveOpenRouterCanary } from "@/lib/ai-gateway/canary.server";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";

const enabled = process.env.GETDONE_OPENROUTER_LIVE === "true";
const describeLive = enabled ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "";

const fixedNow = "2026-09-22T14:30:00.000Z";
const scope = {
  userId: "live-ai-owner",
  portfolioId: "live-ai-portfolio",
  companyId: "live-ai-company",
  environment: "staging" as const
};

const budget = {
  portfolioId: scope.portfolioId,
  companyId: scope.companyId,
  period: "2026-09",
  companyRemainingCents: 500,
  portfolioRemainingCents: 500,
  activeConcurrentCalls: 0,
  concurrencyLimit: 2,
  snapshotAt: "2026-09-22T14:29:00.000Z",
  expiresAt: "2026-09-22T14:40:00.000Z"
};

function liveEnv() {
  return {
    ...process.env,
    GETDONE_RUNTIME_ENV: "staging",
    GETDONE_DATA_MODE: "authoritative",
    GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false",
    OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
    OPENROUTER_TIMEOUT_MS: "20000",
    OPENROUTER_MAX_RETRIES: "2",
    OPENROUTER_RETRY_BASE_DELAY_MS: "250",
    OPENROUTER_CANARY_ENABLED: "true",
    OPENROUTER_CANARY_MODEL: "openai/gpt-5.6-luna"
  };
}

describeLive("live OpenRouter governed proposal acceptance", () => {
  const db = new PostgresDatabase({
    connectionString: databaseUrl,
    maxConnections: 4,
    ssl: process.env.GETDONE_DB_SSL !== "false"
  });

  beforeAll(async () => {
    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      throw new Error("OPENROUTER_API_KEY secret is required for live acceptance");
    }
    await db.query(`TRUNCATE
      ai_gateway_canary_runs,
      ai_gateway_runtime_configs,
      ai_call_audits,
      ai_usage_records
      RESTART IDENTITY CASCADE`);
    resetAIGatewayRuntimeForTests();
  }, 30_000);

  afterAll(async () => {
    resetAIGatewayRuntimeForTests();
    await db.close();
  });

  it("returns a structured proposal, persists complete usage/audit data, and applies no authority", async () => {
    let enqueueCalls = 0;
    const workflow = new MvpBusinessWorkflow(
      getAIGatewayFromEnv(liveEnv()),
      {
        enqueueAuthorizedHttpAction: async () => {
          enqueueCalls += 1;
          throw new Error("AI proposal must never dispatch directly");
        },
        ownerView: async () => null
      },
      () => new Date(fixedNow)
    );

    const proposal = await workflow.propose({
      detection: {
        id: "live-openrouter-detection",
        signalType: "renewal-risk",
        payload: {
          contactId: "contact-live-1",
          riskScore: 0.91
        },
        observedAt: "2026-09-22T14:29:30.000Z"
      },
      scope,
      budget
    });

    expect(proposal).toMatchObject({
      detectionId: "live-openrouter-detection",
      scope,
      capability: "http.request",
      authorityApplied: false
    });
    expect(proposal.summary.length).toBeGreaterThan(0);
    expect(proposal.reason.length).toBeGreaterThan(0);
    expect(proposal.input.operation.length).toBeGreaterThan(0);
    expect(enqueueCalls).toBe(0);

    const audit = await db.query<{
      validation_status: string;
      routing_policy_version: string;
      selected_profile_id: string;
      actual_profile_id: string;
      gateway_id: string;
      provider_id: string;
      model_id: string;
      fallback_used: boolean;
      latency_ms: number;
      input_tokens: number;
      output_tokens: number;
      actual_cost_cents: string;
    }>(
      `SELECT validation_status,routing_policy_version,selected_profile_id,
              actual_profile_id,gateway_id,provider_id,model_id,fallback_used,
              latency_ms,input_tokens,output_tokens,actual_cost_cents
       FROM ai_call_audits
       WHERE request_id='ai-proposal:live-openrouter-detection'`
    );
    expect(audit.rows[0]).toMatchObject({
      validation_status: "valid",
      routing_policy_version: "2026-09-22.1",
      selected_profile_id: "openrouter-luna",
      actual_profile_id: "openrouter-luna",
      gateway_id: "openrouter",
      provider_id: "openrouter",
      model_id: "openai/gpt-5.6-luna",
      fallback_used: false
    });
    expect(audit.rows[0]!.latency_ms).toBeGreaterThanOrEqual(0);
    expect(audit.rows[0]!.input_tokens).toBeGreaterThan(0);
    expect(audit.rows[0]!.output_tokens).toBeGreaterThan(0);
    expect(Number(audit.rows[0]!.actual_cost_cents)).toBeGreaterThanOrEqual(0);

    const usage = await db.query<{
      attempt: number;
      profile_id: string;
      provider_id: string;
      model_id: string;
      input_tokens: number;
      output_tokens: number;
      latency_ms: number;
      outcome: string;
      actual_cost_cents: string;
    }>(
      `SELECT attempt,profile_id,provider_id,model_id,input_tokens,output_tokens,
              latency_ms,outcome,actual_cost_cents
       FROM ai_usage_records
       WHERE request_id='ai-proposal:live-openrouter-detection'
       ORDER BY attempt`
    );
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0]).toMatchObject({
      attempt: 1,
      profile_id: "openrouter-luna",
      provider_id: "openrouter",
      model_id: "openai/gpt-5.6-luna",
      outcome: "valid"
    });
  }, 45_000);

  it("runs the concrete live canary and persists configuration evidence", async () => {
    const result = await runLiveOpenRouterCanary(
      liveEnv(),
      () => new Date("2026-09-22T14:31:00.000Z")
    );
    expect(result).toMatchObject({
      provider: "openrouter",
      configVersion: "2026-09-22.1",
      canary: {
        gatewayId: "openrouter",
        providerId: "openrouter",
        modelId: "openai/gpt-5.6-luna",
        ok: true
      }
    });

    const rows = await db.query<{
      model_id: string;
      ok: boolean;
      config_version: string;
    }>(
      `SELECT c.model_id,c.ok,r.config_version
       FROM ai_gateway_canary_runs c
       JOIN ai_gateway_runtime_configs r ON r.config_hash=c.config_hash`
    );
    expect(rows.rows).toEqual([{
      model_id: "openai/gpt-5.6-luna",
      ok: true,
      config_version: "2026-09-22.1"
    }]);
  }, 45_000);

  it("retains authoritative AI audit data across application runtime restart", async () => {
    resetAIGatewayRuntimeForTests();
    const workflow = new MvpBusinessWorkflow(
      getAIGatewayFromEnv(liveEnv()),
      {
        enqueueAuthorizedHttpAction: async () => {
          throw new Error("proposal-only acceptance must not execute");
        },
        ownerView: async () => null
      },
      () => new Date("2026-09-22T14:32:00.000Z")
    );

    const proposal = await workflow.propose({
      detection: {
        id: "live-openrouter-after-restart",
        signalType: "account-health",
        payload: { accountId: "account-live-2" },
        observedAt: "2026-09-22T14:31:30.000Z"
      },
      scope,
      budget: {
        ...budget,
        snapshotAt: "2026-09-22T14:31:00.000Z",
        expiresAt: "2026-09-22T14:40:00.000Z"
      }
    });
    expect(proposal.authorityApplied).toBe(false);

    const persisted = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ai_call_audits
       WHERE request_id IN (
         'ai-proposal:live-openrouter-detection',
         'ai-proposal:live-openrouter-after-restart'
       )`
    );
    expect(Number(persisted.rows[0].count)).toBe(2);
  }, 45_000);
});
