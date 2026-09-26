import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const verifier = path.join(root, "scripts", "verify-production-runtime.mjs");

const profiles = [
  {
    id: "standard-primary",
    gatewayId: "openrouter",
    providerId: "openrouter",
    modelId: "openai/gpt-5.6-sol",
    enabled: true,
    validationStatus: "validated",
    roles: ["STANDARD"],
    modalities: ["text"],
    supportsTools: true,
    supportsStructuredOutput: true,
    maxContextTokens: 128000,
    allowedDataClasses: ["PUBLIC", "INTERNAL", "CONFIDENTIAL"],
    allowedEnvironments: ["production"],
    health: "healthy",
    latencyClass: "standard",
    inputCostPerMillionTokensCents: 1,
    outputCostPerMillionTokensCents: 1,
    profileVersion: "1.0.0"
  },
  {
    id: "standard-fallback",
    gatewayId: "openrouter",
    providerId: "openrouter",
    modelId: "openai/gpt-5.6-sol-fallback",
    enabled: true,
    validationStatus: "validated",
    roles: ["STANDARD"],
    modalities: ["text"],
    supportsTools: true,
    supportsStructuredOutput: true,
    maxContextTokens: 128000,
    allowedDataClasses: ["PUBLIC", "INTERNAL", "CONFIDENTIAL"],
    allowedEnvironments: ["production"],
    health: "healthy",
    latencyClass: "standard",
    inputCostPerMillionTokensCents: 1,
    outputCostPerMillionTokensCents: 1,
    profileVersion: "1.0.0"
  }
];

function cleanEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      !key.startsWith("GETDONE_")
      && !key.startsWith("OPENROUTER_")
      && !key.startsWith("NEXT_PUBLIC_")
      && key !== "DATABASE_URL"
      && key !== "NODE_ENV"
      && key !== "PROD_HTTP_TOKEN"
    )
  );
}

function baseEnv(): Record<string, string | undefined> {
  return {
    ...cleanEnvironment(),
    NODE_ENV: "production",
    NEXT_PUBLIC_APP_ENV: "production",
    GETDONE_RUNTIME_ENV: "production",
    GETDONE_DATA_MODE: "authoritative",
    GETDONE_PROCESS_ROLE: "web",
    DATABASE_URL: "postgresql://runtime:runtime@127.0.0.1:1/getdone",
    GETDONE_DB_RUNTIME_ROLE: "getdone_tenant_runtime",
    GETDONE_DB_SSL: "false",
    GETDONE_BACKUP_MAX_AGE_HOURS: "24",
    GETDONE_WEBAUTHN_RP_ID: "getdone.example",
    GETDONE_WEBAUTHN_ORIGINS: JSON.stringify(["https://app.getdone.example"]),
    GETDONE_INTERNAL_WORKER_TOKEN: "w".repeat(40),
    GETDONE_OBSERVABILITY_ENABLED: "true",
    GETDONE_OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.getdone.example",
    OPENROUTER_API_KEY: "k".repeat(32),
    OPENROUTER_BASE_URL: "https://" + "openrouter.ai/api/v1",
    OPENROUTER_CANARY_ENABLED: "true",
    OPENROUTER_CANARY_MODEL: "openai/gpt-5.6-sol",
    GETDONE_AI_MODEL_PROFILES_JSON: JSON.stringify(profiles),
    GETDONE_AI_ROUTING_POLICY_JSON: JSON.stringify({
      version: "production-1",
      routes: { STANDARD: ["standard-primary", "standard-fallback"] }
    }),
    GETDONE_CREDENTIAL_DELIVERY_URL: "https://credentials.getdone.example/redeem",
    GETDONE_CREDENTIAL_BROKER_TOKEN: "b".repeat(40),
    GETDONE_HTTP_ACTIONS_JSON: JSON.stringify([{
      name: "crm-sync",
      companyId: "company-prod",
      environment: "production",
      url: "https://api.example.com/actions",
      credentialProviderId: "crm-provider-prod"
    }])
  };
}

function run(overrides: Record<string, string | undefined>) {
  const childEnv = { ...baseEnv(), ...overrides, NODE_ENV: overrides.NODE_ENV ?? "production" };
  return spawnSync(process.execPath, [verifier], {
    cwd: root,
    env: childEnv as NodeJS.ProcessEnv,
    encoding: "utf8"
  });
}

function output(result: ReturnType<typeof run>) {
  return `${result.stderr}\n${result.stdout}`;
}

describe("verify-production-runtime static fail-closed validation", () => {
  it("rejects incomplete production environment identity before database access", () => {
    const result = run({ GETDONE_RUNTIME_ENV: "staging" });
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain("ENVIRONMENT_IDENTITY");
  });

  it("rejects missing database configuration", () => {
    const result = run({ DATABASE_URL: "" });
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain("DATABASE_URL is required");
  });

  it("rejects insecure or mismatched WebAuthn production origins", () => {
    const result = run({
      GETDONE_WEBAUTHN_ORIGINS: JSON.stringify(["http://localhost:3000"])
    });
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain("WEBAUTHN_CONFIG");
  });

  it("rejects missing worker control-plane secret", () => {
    const result = run({ GETDONE_INTERNAL_WORKER_TOKEN: "" });
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain("GETDONE_INTERNAL_WORKER_TOKEN");
  });

  it("rejects AI routing without a production fallback", () => {
    const result = run({
      GETDONE_AI_ROUTING_POLICY_JSON: JSON.stringify({
        version: "production-1",
        routes: { STANDARD: ["standard-primary"] }
      })
    });
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain("ordered primary and fallback");
  });

  it("rejects unknown AI profile references", () => {
    const result = run({
      GETDONE_AI_ROUTING_POLICY_JSON: JSON.stringify({
        version: "production-1",
        routes: { STANDARD: ["standard-primary", "missing-profile"] }
      })
    });
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain("unknown profile missing-profile");
  });

  it("allows optional AI and integrations to be absent and proceeds to database readiness", () => {
    const result = run({
      OPENROUTER_API_KEY: "",
      OPENROUTER_CANARY_ENABLED: "false",
      OPENROUTER_CANARY_MODEL: "",
      GETDONE_AI_MODEL_PROFILES_JSON: "",
      GETDONE_AI_ROUTING_POLICY_JSON: "",
      GETDONE_HTTP_ACTIONS_JSON: "",
      GETDONE_WEBHOOK_ACTIONS_JSON: "",
      GETDONE_GMAIL_ACTIONS_JSON: "",
      GETDONE_SLACK_ACTIONS_JSON: ""
    });
    expect(result.status).not.toBe(0);
    const text = output(result);
    expect(text).toContain("DATABASE_READINESS");
    expect(text).not.toContain("AI_ROUTING");
    expect(text).not.toContain("OPENROUTER_API_KEY is required");
    expect(text).not.toContain("INTEGRATION_CONFIG");
  });

  it("rejects non-production integration bindings and insecure URLs when integrations are configured", () => {
    const result = run({
      GETDONE_HTTP_ACTIONS_JSON: JSON.stringify([{
        name: "crm-sync",
        companyId: "company-prod",
        environment: "development",
        url: "http://localhost:3000/actions",
        credentialProviderId: "crm-provider-prod"
      }])
    });
    expect(result.status).not.toBe(0);
    const text = output(result);
    expect(text).toContain("NON_PRODUCTION_INTEGRATION");
    expect(text).toContain("INSECURE_URL");
  });

  it("rejects development-only and legacy session settings in production", () => {
    const result = run({
      GETDONE_NODE_IDENTITY_DEV_SECRET: "development-secret",
      GETDONE_OWNER_SESSION_TOKEN: "legacy-session-token"
    });
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain("PROHIBITED_PRODUCTION_SETTING");
  });

  it("rejects secret-looking NEXT_PUBLIC runtime values", () => {
    const publicSecretName = ["NEXT", "PUBLIC", "API", "KEY"].join("_");
    const result = run({
      [publicSecretName]: "should-never-be-public"
    });
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain("PUBLIC_SECRET");
  });
});
