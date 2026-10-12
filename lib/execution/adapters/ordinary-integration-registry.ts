import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { BusinessActionAdapterBinding } from "@/lib/execution/adapters/business-action-registry";
import {
  ConfiguredHttpActionAdapter,
  readConfiguredHttpOperationsFromEnv
} from "@/lib/execution/adapters/configured-http-action";
import {
  ConfiguredWebhookActionAdapter,
  readConfiguredWebhookOperationsFromEnv
} from "@/lib/execution/adapters/configured-webhook-action";
import {
  GmailBusinessActionAdapter,
  readGmailProviderConfigurationsFromEnv
} from "@/lib/execution/adapters/gmail-action";
import {
  SlackBusinessActionAdapter,
  readSlackProviderConfigurationsFromEnv
} from "@/lib/execution/adapters/slack-action";
import {
  CrmBusinessActionAdapter,
  readCrmProviderConfigurationsFromEnv
} from "@/lib/execution/adapters/crm-action";
import {
  GithubStandardOperationAdapter,
  readGithubProviderConfigurationsFromEnv
} from "@/lib/execution/adapters/github-standard-operation";
import {
  AnalyticsDataIngestionAdapter,
  readAnalyticsSourceConfigurationsFromEnv
} from "@/lib/execution/adapters/analytics-ingestion";
import type { AnalyticsIngestionEvidenceStore } from "@/lib/analytics/ingestion";
import { N8nGithubAdapter, N8nDeploymentAdapter, type N8nConfiguration, type N8nAdapterOptions, type N8nDeploymentConfiguration } from "@/lib/operations/n8n-adapter";

export const ORDINARY_INTEGRATION_IMPLEMENTATION_ORDER = Object.freeze([
  "generic-configured-https",
  "webhook",
  "email",
  "slack",
  "crm",
  "github-standard-operations",
  "analytics-data-ingestion",
  "scheduling-calendar",
  "saas-specific"
] as const);

export interface OrdinaryIntegrationRegistryOptions {
  analyticsStore?: AnalyticsIngestionEvidenceStore;
  n8nAuthority?: N8nAdapterOptions["authority"];
  n8nEvidence?: N8nAdapterOptions["onEvidence"];
  n8nDegraded?: N8nAdapterOptions["onDegraded"];
}

export function createOrdinaryBusinessActionBindingsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: OrdinaryIntegrationRegistryOptions = {}
): readonly BusinessActionAdapterBinding[] {
  const bindings: BusinessActionAdapterBinding[] = [];

  if (env.GETDONE_N8N_ENABLED === "true") {
    if (env.GETDONE_HTTP_ACTIONS_JSON?.trim()) throw new ControlPlaneError("POLICY_BLOCKED", "Narrow n8n mode cannot also bind arbitrary HTTP actions");
    let configs: N8nDeploymentConfiguration[];
    try { configs = JSON.parse(env.GETDONE_N8N_DEPLOYMENT_WORKFLOWS_JSON ?? "null"); }
    catch { throw new ControlPlaneError("VALIDATION_FAILED", "Invalid deployment health workflow registration JSON"); }
    if (!Array.isArray(configs)) throw new ControlPlaneError("UNAVAILABLE", "Register deployment health before enabling narrow n8n mode");
    bindings.push({ capability: "http.request", adapter: new N8nDeploymentAdapter(configs, env.GETDONE_N8N_SIGNING_KEY ?? "", { onEvidence: options.n8nEvidence, onDegraded: options.n8nDegraded }) });
    if (!options.n8nAuthority || !options.n8nEvidence) throw new ControlPlaneError("UNAVAILABLE", "Narrow n8n mode requires durable preview authorization and evidence synchronization");
    let githubWorkflows: N8nConfiguration[];
    try { githubWorkflows = JSON.parse(env.GETDONE_N8N_GITHUB_WORKFLOWS_JSON ?? "null"); }
    catch { throw new ControlPlaneError("VALIDATION_FAILED", "Invalid n8n GitHub workflow registration JSON"); }
    if (!Array.isArray(githubWorkflows) || !githubWorkflows.length) throw new ControlPlaneError("UNAVAILABLE", "Register both GitHub workflows before enabling narrow n8n mode");
    const narrow = new N8nGithubAdapter(githubWorkflows, readGithubProviderConfigurationsFromEnv(env), env.GETDONE_N8N_SIGNING_KEY ?? "",
      { authority: options.n8nAuthority, onEvidence: options.n8nEvidence, onDegraded: options.n8nDegraded });
    return Object.freeze([...bindings, { capability: "github.repository.read", adapter: narrow }, { capability: "github.branch.create", adapter: narrow }]);
  } else if (env.GETDONE_HTTP_ACTIONS_JSON?.trim()) {
    bindings.push({
      capability: "http.request",
      adapter: new ConfiguredHttpActionAdapter(
        readConfiguredHttpOperationsFromEnv(env)
      )
    });
  }

  if (env.GETDONE_WEBHOOK_ACTIONS_JSON?.trim()) {
    bindings.push({
      capability: "webhook.send",
      adapter: new ConfiguredWebhookActionAdapter(
        readConfiguredWebhookOperationsFromEnv(env)
      )
    });
  }

  if (env.GETDONE_GMAIL_ACTIONS_JSON?.trim()) {
    bindings.push({
      capability: "email.send",
      adapter: new GmailBusinessActionAdapter(
        readGmailProviderConfigurationsFromEnv(env)
      )
    });
  }

  if (env.GETDONE_SLACK_ACTIONS_JSON?.trim()) {
    bindings.push({
      capability: "slack.message.send",
      adapter: new SlackBusinessActionAdapter(
        readSlackProviderConfigurationsFromEnv(env)
      )
    });
  }

  if (env.GETDONE_CRM_ACTIONS_JSON?.trim()) {
    const crm = new CrmBusinessActionAdapter(
      readCrmProviderConfigurationsFromEnv(env)
    );
    bindings.push(
      { capability: "crm.record.read", adapter: crm },
      { capability: "crm.record.write", adapter: crm }
    );
  }

  if (env.GETDONE_GITHUB_ACTIONS_JSON?.trim()) {
    const github = new GithubStandardOperationAdapter(
      readGithubProviderConfigurationsFromEnv(env)
    );
    bindings.push(
      { capability: "github.repository.read", adapter: github },
      { capability: "github.branch.create", adapter: github },
      { capability: "github.commit.create", adapter: github },
      { capability: "github.protected-branch.commit", adapter: github },
      { capability: "github.pull-request.write", adapter: github },
      { capability: "github.issue.write", adapter: github },
      { capability: "github.pull-request.merge", adapter: github }
    );
  }

  if (env.GETDONE_ANALYTICS_SOURCES_JSON?.trim()) {
    if (!options.analyticsStore) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "Analytics ingestion requires durable evidence/checkpoint persistence"
      );
    }
    bindings.push({
      capability: "analytics.ingest.read",
      adapter: new AnalyticsDataIngestionAdapter(
        readAnalyticsSourceConfigurationsFromEnv(env),
        options.analyticsStore
      )
    });
  }

  if (bindings.length === 0) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "At least one ordinary business integration must be configured"
    );
  }

  return Object.freeze(bindings);
}
