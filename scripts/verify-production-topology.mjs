import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const topology = JSON.parse(fs.readFileSync(
  path.join(root, "deploy/production/topology.json"),
  "utf8"
));
const manifest = JSON.parse(fs.readFileSync(
  path.join(root, "deploy/production/kubernetes.template.json"),
  "utf8"
));

const failures = [];
const items = manifest.items ?? [];
const by = (kind, name) => items.find(
  (item) => item.kind === kind && item.metadata?.name === name
);
const requireItem = (kind, name) => {
  const item = by(kind, name);
  if (!item) failures.push(`missing ${kind}/${name}`);
  return item;
};

if (topology.platform !== "kubernetes" || topology.namespace !== "getdone") {
  failures.push("topology must declare Kubernetes namespace getdone");
}
if (topology.database?.engine !== "postgresql" || topology.database?.minimumVersion !== "16") {
  failures.push("topology must declare PostgreSQL 16+ dependency");
}
if (topology.database?.mode !== "managed-external" || topology.database?.tlsRequired !== true) {
  failures.push("production PostgreSQL must be external-managed and TLS-required");
}
if (topology.rolloutPolicy?.migrationBeforeRuntime !== true) {
  failures.push("database migration must be a rollout prerequisite");
}
if (topology.rolloutPolicy?.requireImmutableImages !== true) {
  failures.push("production images must be immutable");
}

const secret = requireItem("Secret", "getdone-runtime-secrets");
for (const key of topology.requiredSecrets ?? []) {
  if (!(key in (secret?.data ?? {}))) failures.push(`runtime Secret missing ${key}`);
}
for (const raw of Object.values(secret?.data ?? {})) {
  if (typeof raw === "string" && /sk-[A-Za-z0-9_-]{20,}/.test(raw)) {
    failures.push("deployment template contains a raw secret");
  }
}

const config = requireItem("ConfigMap", "getdone-runtime-config");
for (const [key,value] of Object.entries({
  GETDONE_RUNTIME_ENV:"production",
  NEXT_PUBLIC_APP_ENV:"production",
  GETDONE_DATA_MODE:"authoritative",
  GETDONE_DB_RUNTIME_ROLE:"getdone_tenant_runtime",
  GETDONE_AUTH_COOKIE_SECURE:"true",
  OPENROUTER_CANARY_ENABLED:"true",
  GETDONE_OBSERVABILITY_ENABLED:"true"
})) {
  if (config?.data?.[key] !== value) failures.push(`runtime ConfigMap ${key} drifted`);
}

const migration = requireItem("Job", "getdone-db-migrate");
const migrateContainer = migration?.spec?.template?.spec?.containers?.[0];
if (JSON.stringify(migrateContainer?.command) !== JSON.stringify(["npm","run","db:migrate"])) {
  failures.push("migration Job must run npm run db:migrate");
}

function verifyDeployment(name, options) {
  const deployment = requireItem("Deployment", name);
  if (!deployment) return;
  if (deployment.spec?.replicas < 2) failures.push(`${name} requires at least two replicas`);
  const rolling = deployment.spec?.strategy?.rollingUpdate;
  if (deployment.spec?.strategy?.type !== "RollingUpdate"
      || rolling?.maxUnavailable !== 0
      || rolling?.maxSurge !== 1) {
    failures.push(`${name} rollout must use maxUnavailable=0/maxSurge=1`);
  }
  const container = deployment.spec?.template?.spec?.containers?.[0];
  if (container?.image !== options.imageToken) failures.push(`${name} image token drifted`);
  if (!container?.readinessProbe || !container?.livenessProbe || !container?.startupProbe) {
    failures.push(`${name} requires startup/readiness/liveness probes`);
  }
  if (container?.readinessProbe?.httpGet?.path !== options.readiness) {
    failures.push(`${name} readiness path drifted`);
  }
  if (container?.livenessProbe?.httpGet?.path !== options.liveness) {
    failures.push(`${name} liveness path drifted`);
  }
  if (!container?.resources?.requests || !container?.resources?.limits) {
    failures.push(`${name} requires resource requests and limits`);
  }
  if (container?.securityContext?.allowPrivilegeEscalation !== false
      || container?.securityContext?.readOnlyRootFilesystem !== true) {
    failures.push(`${name} container hardening drifted`);
  }
  if (deployment.spec?.template?.spec?.automountServiceAccountToken !== false) {
    failures.push(`${name} must not mount Kubernetes API credentials`);
  }
}

verifyDeployment("getdone-web", {
  imageToken:"__WEB_IMAGE__",
  readiness:"/api/control/health",
  liveness:"/api/health"
});
verifyDeployment("getdone-worker", {
  imageToken:"__WORKER_IMAGE__",
  readiness:"/readyz",
  liveness:"/livez"
});
verifyDeployment("getdone-orchestration-worker", {
  imageToken:"__WORKER_IMAGE__",
  readiness:"/readyz",
  liveness:"/livez"
});

for (const name of ["getdone-worker","getdone-orchestration-worker"]) {
  const worker = by("Deployment",name);
  if (worker?.spec?.template?.spec?.terminationGracePeriodSeconds < 120) {
    failures.push(`${name} termination grace period must allow durable drain`);
  }
  const workerContainer = worker?.spec?.template?.spec?.containers?.[0];
  if (!workerContainer?.lifecycle?.preStop) {
    failures.push(`${name} requires a preStop drain window`);
  }
}

const orchestrationWorker = by("Deployment","getdone-orchestration-worker");
const orchestrationContainer = orchestrationWorker?.spec?.template?.spec?.containers?.[0];
const orchestrationEnv = new Map(
  (orchestrationContainer?.env ?? []).map((entry) => [entry.name,entry])
);
if (orchestrationEnv.get("GETDONE_PROCESS_ROLE")?.value !== "orchestration-worker") {
  failures.push("orchestration worker must run with GETDONE_PROCESS_ROLE=orchestration-worker");
}
if (!orchestrationEnv.get("GETDONE_ORCHESTRATION_WORKER_ID")?.valueFrom?.fieldRef) {
  failures.push("orchestration worker must derive a unique durable worker id from the Pod");
}
if (JSON.stringify(orchestrationContainer?.command)
    !== JSON.stringify(["npm","run","start:orchestration-worker"])) {
  failures.push("orchestration worker must run the dedicated orchestration entrypoint");
}
if (orchestrationContainer?.ports?.[0]?.containerPort !== 3002) {
  failures.push("orchestration worker health port must be 3002");
}

for (const key of [
  "GETDONE_ORCHESTRATION_LEASE_SECONDS",
  "GETDONE_ORCHESTRATION_HEARTBEAT_SECONDS",
  "GETDONE_ORCHESTRATION_BATCH_SIZE",
  "GETDONE_ORCHESTRATION_CONCURRENCY",
  "GETDONE_ORCHESTRATION_MAX_PLAN_COST_CENTS",
  "GETDONE_ORCHESTRATION_MAX_STEP_COST_CENTS",
  "GETDONE_AI_COMPANY_DAILY_BUDGET_CENTS",
  "GETDONE_AI_PORTFOLIO_DAILY_BUDGET_CENTS"
]) {
  if (!config?.data?.[key]) failures.push(`runtime ConfigMap missing ${key}`);
}

for (const name of ["getdone-web","getdone-worker","getdone-orchestration-worker"]) {
  const pdb = requireItem("PodDisruptionBudget", name);
  if (pdb?.spec?.minAvailable !== 1) failures.push(`${name} PDB must keep one instance available`);
  const hpa = requireItem("HorizontalPodAutoscaler", name);
  if (hpa?.spec?.minReplicas < 2 || hpa?.spec?.maxReplicas <= hpa?.spec?.minReplicas) {
    failures.push(`${name} HPA bounds are unsafe`);
  }
}

const ingress = requireItem("Ingress","getdone-web");
if (!ingress?.spec?.tls?.[0]?.secretName
    || ingress?.metadata?.annotations?.["nginx.ingress.kubernetes.io/ssl-redirect"] !== "true") {
  failures.push("web ingress must terminate TLS and force HTTPS");
}

requireItem("NetworkPolicy","getdone-default-deny");
const egress = requireItem("NetworkPolicy","getdone-egress");
const egressPorts = new Set(
  (egress?.spec?.egress ?? []).flatMap((rule) => rule.ports ?? []).map((entry) => String(entry.port))
);
for (const port of ["53","443","5432"]) {
  if (!egressPorts.has(port)) failures.push(`egress policy missing required port ${port}`);
}

if (!fs.existsSync(path.join(root,"Dockerfile.web"))
    || !fs.existsSync(path.join(root,"Dockerfile.worker"))) {
  failures.push("web and worker Dockerfiles are required");
}

if (failures.length > 0) {
  console.error(JSON.stringify({ok:false,verifier:"production-topology",failures},null,2));
  process.exit(1);
}
console.log(JSON.stringify({
  ok:true,
  verifier:"production-topology",
  topologyId:topology.topologyId,
  resources:items.length,
  webReplicas:topology.services.web.replicas,
  workerReplicas:topology.services.worker.replicas,
  orchestrationWorkerReplicas:topology.services.orchestrationWorker?.replicas,
  tls:true,
  defaultDenyNetwork:true,
  managedPostgres:true
},null,2));
