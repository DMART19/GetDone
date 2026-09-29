import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const digest = "a".repeat(64);
const workerDigest = "b".repeat(64);
const secretToken = "worker-secret-abcdefghijklmnopqrstuvwxyz-1234567890";
const openRouterKey = "openrouter-secret-abcdefghijklmnopqrstuvwxyz";
const runChildProcessChecks =
  process.env.GITHUB_ACTIONS === "true"
  || process.env.GETDONE_RUN_CHILD_PROCESS_TESTS === "true";

const profiles = [
  {
    id: "primary",
    gatewayId: "openrouter",
    providerId: "openrouter",
    modelId: "openai/gpt-5.6-sol",
    enabled: true,
    validationStatus: "validated",
    health: "healthy",
    allowedEnvironments: ["production"]
  },
  {
    id: "fallback",
    gatewayId: "openrouter",
    providerId: "openrouter",
    modelId: "openai/gpt-5.6-sol-fallback",
    enabled: true,
    validationStatus: "validated",
    health: "healthy",
    allowedEnvironments: ["production"]
  }
];

function parseJsonOutput(result: SpawnSyncReturns<string>) {
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  expect(result.stdout.trim(), "script must emit JSON on stdout").not.toBe("");
  return JSON.parse(result.stdout);
}

function render(phase: "all" | "migration" | "runtime" = "all", overrides = {}) {
  return spawnSync(
    "node",
    ["scripts/render-production-deployment.mjs", `--phase=${phase}`],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GETDONE_PUBLIC_HOST: "app.getdone.example",
        GETDONE_WEB_IMAGE: `registry.example/getdone-web@sha256:${digest}`,
        GETDONE_WORKER_IMAGE: `registry.example/getdone-worker@sha256:${workerDigest}`,
        DATABASE_URL: "postgresql://getdone:password@postgres.example:5432/getdone?sslmode=require",
        GETDONE_INTERNAL_WORKER_TOKEN: secretToken,
        OPENROUTER_API_KEY: openRouterKey,
        OPENROUTER_BASE_URL: "https://" + "openrouter.ai/api/v1",
        GETDONE_AI_MODEL_PROFILES_JSON: JSON.stringify(profiles),
        GETDONE_AI_ROUTING_POLICY_JSON: JSON.stringify({
          version: "prod-1",
          routes: { STANDARD: ["primary", "fallback"] }
        }),
        OPENROUTER_CANARY_MODEL: "openai/gpt-5.6-sol",
        GETDONE_OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.getdone.example",
        GETDONE_HTTP_ACTIONS_JSON: JSON.stringify([{
          name: "status-sync",
          companyId: "company-prod",
          environment: "production",
          url: "https://api.example.com/actions"
        }]),
        GETDONE_WEBHOOK_ACTIONS_JSON: "[]",
        GETDONE_GMAIL_ACTIONS_JSON: "[]",
        GETDONE_SLACK_ACTIONS_JSON: "[]",
        GETDONE_PROVIDER_CONCURRENCY_LIMITS_JSON: "{}",
        ...overrides
      }
    }
  );
}

describe.runIf(runChildProcessChecks)("production deployment topology", () => {
  it("passes the static production topology verifier", () => {
    const result = spawnSync(
      "node",
      ["scripts/verify-production-topology.mjs"],
      { cwd: root, encoding: "utf8", env: process.env }
    );
    expect(parseJsonOutput(result)).toMatchObject({
      ok: true,
      verifier: "production-topology",
      tls: true,
      defaultDenyNetwork: true,
      managedPostgres: true
    });
  });

  it("renders immutable production runtime resources without exposing raw secrets", () => {
    const result = render("all");
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(result.stdout).not.toContain(secretToken);
    expect(result.stdout).not.toContain(openRouterKey);
    expect(result.stdout).not.toMatch(/__[A-Z0-9_]+__/);

    const manifest = parseJsonOutput(result);
    const kinds = manifest.items.map((item: { kind: string }) => item.kind);
    expect(kinds).toContain("Job");
    expect(kinds.filter((kind: string) => kind === "Deployment")).toHaveLength(2);

    const ingress = manifest.items.find(
      (item: { kind: string; metadata?: { name?: string } }) =>
        item.kind === "Ingress" && item.metadata?.name === "getdone-web"
    );
    expect(ingress.spec.tls[0].hosts).toEqual(["app.getdone.example"]);

    const web = manifest.items.find(
      (item: { kind: string; metadata?: { name?: string } }) =>
        item.kind === "Deployment" && item.metadata?.name === "getdone-web"
    );
    expect(web.spec.template.spec.containers[0].image)
      .toBe(`registry.example/getdone-web@sha256:${digest}`);
  });

  it("renders migration and runtime as separate rollout phases", () => {
    const migration = render("migration");
    const migrationKinds = parseJsonOutput(migration).items.map(
      (item: { kind: string }) => item.kind
    );
    expect(migrationKinds).toContain("Job");
    expect(migrationKinds).not.toContain("Deployment");

    const runtime = render("runtime");
    const runtimeKinds = parseJsonOutput(runtime).items.map(
      (item: { kind: string }) => item.kind
    );
    expect(runtimeKinds).not.toContain("Job");
    expect(runtimeKinds.filter((kind: string) => kind === "Deployment")).toHaveLength(2);
  });

  it("refuses mutable images and non-TLS PostgreSQL", () => {
    const mutable = render("all", {
      GETDONE_WEB_IMAGE: "registry.example/getdone-web:latest"
    });
    expect(mutable.status).not.toBe(0);
    expect(mutable.stderr).toMatch(/immutable image reference/i);

    const insecureDatabase = render("all", {
      DATABASE_URL: "postgresql://getdone:password@postgres.example:5432/getdone?sslmode=disable"
    });
    expect(insecureDatabase.status).not.toBe(0);
    expect(insecureDatabase.stderr).toMatch(/must not disable PostgreSQL TLS/i);
  });
});
