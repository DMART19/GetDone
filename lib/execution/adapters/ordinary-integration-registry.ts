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

export function createOrdinaryBusinessActionBindingsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): readonly BusinessActionAdapterBinding[] {
  const bindings: BusinessActionAdapterBinding[] = [];

  if (env.GETDONE_HTTP_ACTIONS_JSON?.trim()) {
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

  if (bindings.length === 0) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "At least one ordinary business integration must be configured"
    );
  }

  return Object.freeze(bindings);
}
