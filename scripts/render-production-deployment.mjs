import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function immutableImage(name) {
  const value = required(name);
  if (!/^[A-Za-z0-9._/:@-]+@sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be an immutable image reference ending in @sha256:<64 hex>`);
  }
  return value;
}

function exactHttps(name, fallback) {
  const raw = process.env[name]?.trim() || fallback;
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error(`${name} must use https://`);
  return raw;
}

function jsonArray(name, fallback = "[]") {
  const raw = process.env[name]?.trim() || fallback;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${name} must be a JSON array`);
  return { raw, parsed };
}

function jsonObject(name, fallback = "{}") {
  const raw = process.env[name]?.trim() || fallback;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return { raw, parsed };
}

function secret(name, minimumLength) {
  const value = required(name);
  if (value.length < minimumLength) throw new Error(`${name} is too short`);
  return value;
}

function b64(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function escapeJsonStringContent(value) {
  return JSON.stringify(value).slice(1, -1);
}

function substitute(text, token, value) {
  if (!text.includes(token)) throw new Error(`Deployment template is missing ${token}`);
  return text.replaceAll(token, escapeJsonStringContent(value));
}

const host = required("GETDONE_PUBLIC_HOST").toLowerCase();
if (
  !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
  || host === "localhost"
) {
  throw new Error("GETDONE_PUBLIC_HOST must be a production DNS hostname");
}

const webImage = immutableImage("GETDONE_WEB_IMAGE");
const workerImage = immutableImage("GETDONE_WORKER_IMAGE");
const databaseUrl = required("DATABASE_URL");
const database = new URL(databaseUrl);
if (!["postgres:", "postgresql:"].includes(database.protocol)) {
  throw new Error("DATABASE_URL must use PostgreSQL");
}
if (["localhost", "127.0.0.1", "::1"].includes(database.hostname)) {
  throw new Error("Production DATABASE_URL must not target loopback");
}
if (database.searchParams.get("sslmode") === "disable") {
  throw new Error("Production DATABASE_URL must not disable PostgreSQL TLS");
}

const internalWorkerToken = secret("GETDONE_INTERNAL_WORKER_TOKEN", 32);
const openRouterKey = secret("OPENROUTER_API_KEY", 16);
const profiles = jsonArray("GETDONE_AI_MODEL_PROFILES_JSON");
if (profiles.parsed.length < 2) {
  throw new Error("GETDONE_AI_MODEL_PROFILES_JSON must contain primary and fallback profiles");
}
const routing = jsonObject("GETDONE_AI_ROUTING_POLICY_JSON");
if (!routing.parsed.version || !routing.parsed.routes) {
  throw new Error("GETDONE_AI_ROUTING_POLICY_JSON must include version and routes");
}

const integrations = {
  GETDONE_HTTP_ACTIONS_JSON: jsonArray("GETDONE_HTTP_ACTIONS_JSON"),
  GETDONE_WEBHOOK_ACTIONS_JSON: jsonArray("GETDONE_WEBHOOK_ACTIONS_JSON"),
  GETDONE_GMAIL_ACTIONS_JSON: jsonArray("GETDONE_GMAIL_ACTIONS_JSON"),
  GETDONE_SLACK_ACTIONS_JSON: jsonArray("GETDONE_SLACK_ACTIONS_JSON"),
  GETDONE_CRM_ACTIONS_JSON: jsonArray("GETDONE_CRM_ACTIONS_JSON"),
  GETDONE_GITHUB_ACTIONS_JSON: jsonArray("GETDONE_GITHUB_ACTIONS_JSON"),
  GETDONE_ANALYTICS_SOURCES_JSON: jsonArray("GETDONE_ANALYTICS_SOURCES_JSON"),
  GETDONE_CALENDAR_ACTIONS_JSON: jsonArray("GETDONE_CALENDAR_ACTIONS_JSON")
};
if (Object.values(integrations).every((entry) => entry.parsed.length === 0)) {
  throw new Error("At least one governed production integration must be configured");
}

const usesBroker = Object.values(integrations)
  .flatMap((entry) => entry.parsed)
  .some((entry) => entry && typeof entry === "object" && typeof entry.credentialProviderId === "string");

const credentialBrokerToken = process.env.GETDONE_CREDENTIAL_BROKER_TOKEN?.trim() || "";
const credentialDeliveryUrl = process.env.GETDONE_CREDENTIAL_DELIVERY_URL?.trim() || "";
if (usesBroker) {
  if (credentialBrokerToken.length < 32) {
    throw new Error("GETDONE_CREDENTIAL_BROKER_TOKEN is required for brokered integrations");
  }
  exactHttps("GETDONE_CREDENTIAL_DELIVERY_URL");
}

const openRouterBase = exactHttps("OPENROUTER_BASE_URL");
if (!["openrouter.ai", "eu.openrouter.ai"].includes(new URL(openRouterBase).hostname)) {
  throw new Error("OPENROUTER_BASE_URL must use an approved OpenRouter hostname");
}
const otelEndpoint = exactHttps("GETDONE_OTEL_EXPORTER_OTLP_ENDPOINT");
const canaryModel = required("OPENROUTER_CANARY_MODEL");
const providerLimits = jsonObject("GETDONE_PROVIDER_CONCURRENCY_LIMITS_JSON").raw;

let output = fs.readFileSync(
  path.join(root, "deploy/production/kubernetes.template.json"),
  "utf8"
);
for (const [token,value] of Object.entries({
  "__DATABASE_URL_B64__": b64(databaseUrl),
  "__GETDONE_INTERNAL_WORKER_TOKEN_B64__": b64(internalWorkerToken),
  "__OPENROUTER_API_KEY_B64__": b64(openRouterKey),
  "__GETDONE_CREDENTIAL_BROKER_TOKEN_B64__": b64(credentialBrokerToken),
  "__PUBLIC_HOST__": host,
  "__WEB_IMAGE__": webImage,
  "__WORKER_IMAGE__": workerImage,
  "__OPENROUTER_BASE_URL__": openRouterBase,
  "__AI_MODEL_PROFILES_JSON__": profiles.raw,
  "__AI_ROUTING_POLICY_JSON__": routing.raw,
  "__OPENROUTER_CANARY_MODEL__": canaryModel,
  "__OTEL_ENDPOINT__": otelEndpoint,
  "__HTTP_ACTIONS_JSON__": integrations.GETDONE_HTTP_ACTIONS_JSON.raw,
  "__WEBHOOK_ACTIONS_JSON__": integrations.GETDONE_WEBHOOK_ACTIONS_JSON.raw,
  "__GMAIL_ACTIONS_JSON__": integrations.GETDONE_GMAIL_ACTIONS_JSON.raw,
  "__SLACK_ACTIONS_JSON__": integrations.GETDONE_SLACK_ACTIONS_JSON.raw,
  "__CRM_ACTIONS_JSON__": integrations.GETDONE_CRM_ACTIONS_JSON.raw,
  "__GITHUB_ACTIONS_JSON__": integrations.GETDONE_GITHUB_ACTIONS_JSON.raw,
  "__ANALYTICS_SOURCES_JSON__": integrations.GETDONE_ANALYTICS_SOURCES_JSON.raw,
  "__CALENDAR_ACTIONS_JSON__": integrations.GETDONE_CALENDAR_ACTIONS_JSON.raw,
  "__CREDENTIAL_DELIVERY_URL__": credentialDeliveryUrl,
  "__PROVIDER_LIMITS_JSON__": providerLimits
})) {
  output = substitute(output, token, value);
}

const manifest = JSON.parse(output);
const phaseArg = process.argv.find((arg) => arg.startsWith("--phase="));
const phase = phaseArg?.split("=")[1] || "all";
if (!["all", "migration", "runtime"].includes(phase)) {
  throw new Error("--phase must be all, migration, or runtime");
}

if (phase !== "all") {
  const sharedKinds = new Set(["Namespace", "Secret", "ConfigMap", "ServiceAccount", "NetworkPolicy"]);
  manifest.items = manifest.items.filter((item) => {
    if (sharedKinds.has(item.kind)) return true;
    if (phase === "migration") return item.kind === "Job";
    return item.kind !== "Job";
  });
}

process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
