# Ordinary Integrations and Business Adapters

Date: 2026-09-22

## Scope

This tranche implements the first ordinary integrations on top of the existing Business Action contract and durable governed Job pipeline. It deliberately does not expand Resource Fabric.

Implementation order is encoded in `ORDINARY_INTEGRATION_IMPLEMENTATION_ORDER`:

1. generic configured HTTPS action
2. webhook
3. email (Gmail)
4. Slack
5. CRM
6. GitHub standard operations
7. analytics/data ingestion
8. scheduling/calendar
9. other SaaS-specific adapters

Items 1-7 are implemented. Items 8-9 remain ordered follow-on work.

## Shared governance

The ordinary integration framework enforces or declares:

- capability identity
- server-controlled provider/endpoint configuration
- credential lease references only in persisted Jobs/specs
- minimum provider scopes and separate verification scopes where needed
- bounded request timeouts
- required idempotency lineage
- explicit retry taxonomy
- provider operation IDs
- status/resume behavior when supported
- response-size limits before full buffering
- hashed provider evidence
- independent verification strategy for consequential/configured actions
- cancellation where the provider supports it
- tenant and environment binding
- provider acceptance semantics that do not grant adapter authority

Raw credentials are never part of Job input or persisted execution specs. Credential-bearing Business Actions carry only a `credentialLeaseId`. Immediately before execute/status/cancel, the governed runtime broker validates the persisted tenant-scoped lease, checks Job/resource/capability/provider/scope binding, redeems its opaque delivery reference into short-lived scoped material, records a credential-usage audit, and passes the material only in-memory to the adapter. Ordinary adapters do not resolve long-lived provider tokens from environment variables.

## Implemented adapters

### Configured HTTPS

`http.request` executes a fixed server-configured HTTPS operation. Target URLs cannot come from the Job/model payload. The adapter is tenant/environment bound, emits retry classes, bounds provider responses, and returns hashed evidence.

### Webhook

`webhook.send` executes fixed configured webhooks. Consequential webhook configurations fail closed unless an independent verification endpoint is also configured. Optional cancellation endpoints use the persisted provider operation ID and freshly brokered short-lived credential material. Signed webhook delivery can use HMAC-SHA256 over the exact request body and timestamp.

### Gmail

`email.send` uses Gmail's send API with the minimum send scope declared separately from optional read-only verification scope. The initial Gmail send response is provider acceptance. When provider-object verification is configured, the adapter returns `accepted` first and only reaches completed provider evidence after a separate message read confirms the object.

### Slack

`slack.message.send` uses `chat.postMessage`, a deterministic client message ID derived from GetDone idempotency lineage, optional provider-object verification, and `chat.delete` cancellation. Initial Slack `ok` means the provider accepted the request; it is not treated as independent business truth.

### CRM

`crm.record.read` and `crm.record.write` provide one provider-neutral CRM surface for contacts, companies, and deals. Provider endpoints, credential provider, response ID/property paths, and object collection/item paths are server-configured and tenant/environment bound.

Reads can complete from the bounded provider read response. Creates and updates cannot: a successful provider mutation only returns `accepted`. The provider operation lineage stores the provider record ID plus a hash of the exact fields that must be observed. `status()` performs a fresh object read and reaches `completed` only when the independently read record matches those authorized mutation fields. Eventual-consistency mismatches remain `running`; malformed or non-retryable verification responses fail closed.

## Credential runtime path

Credential-bearing ordinary integrations follow:

1. Job/spec persists only `credentialLeaseId`;
2. worker re-reads authoritative Job and authorization lineage;
3. adapter declares provider/scopes required for the concrete operation;
4. broker loads the tenant-scoped credential lease from PostgreSQL;
5. broker validates Job, Resource, capability, provider, scope and expiry;
6. broker redeems the opaque `deliveryRef` into short-lived material;
7. a credential-usage audit is persisted without the secret material;
8. material exists only in the execution context for the provider call.

The production runtime fails closed if a credential-bearing adapter is invoked without the governed broker. Legacy `credentialRef` / `authorizationEnv` ordinary-integration configuration is rejected by the production validator.

## Authority path

The runtime now exposes `enqueueAuthorizedBusinessAction` as the generic dispatch entrypoint. It:

1. re-reads the persisted authoritative queued Job
2. verifies the Job snapshot hash/version
3. verifies exact Task authorization-consumption lineage
4. verifies trusted scope equality
5. validates capability input
6. persists the `business-action` execution spec
7. enqueues the same durable Job envelope used by every Business Action
8. lets `RoutedJobExecutionHandler` re-read authority again immediately before execution
9. persists provider evidence and verification evidence without allowing the adapter to mutate Job truth

The old `enqueueAuthorizedHttpAction` remains only as a compatibility wrapper and delegates to the generic method; it does not implement a separate authority path.

## Exit gate

`lib/execution/ordinary-integration-pipeline.test.ts` proves configured HTTPS, webhook, and Gmail execute through the same `RoutedJobExecutionHandler`, authoritative Job re-read, authorization-consumption checks, Business Action orchestrator, and verification store. There are no per-integration authority shortcuts in the test path.

Provider-specific hostile/malformed response tests are in `lib/execution/adapters/ordinary-integration-adapters.test.ts`.

## Release truth

The repository contains production-wirable adapters and governed integration code. Live provider acceptance is not claimed until real provider credentials/configuration are installed and the deployment runs the adapters against the providers. The controlled configured-HTTPS and signed-webhook staging suites exercise real external HTTPS/DNS with ephemeral runtime credentials. Gmail, Slack, and CRM real-provider acceptance remains credential-gated. CRM implementation evidence does not mark an environment connected; only a fresh exact-SHA `crm-live-acceptance` artifact that satisfies the environment evidence policy can do that.


### GitHub standard operations

`github.repository.read` covers governed repository metadata, branch, file, pull-request, issue, checks, and commit-status retrieval. Mutating capabilities cover branch creation, multi-file commit creation, pull-request create/update, issue create/update, and pull-request merge. All GitHub configuration is server-side, repository-allowlisted, tenant/environment bound, and uses brokered short-lived credential material.

Provider mutation responses are never authoritative Job completion. Branch, commit, PR, issue, and merge operations return `accepted` plus bounded provider-operation lineage; `status()` performs a fresh GitHub read and only reaches `completed` when the independently observed provider state matches the authorized mutation.

Protected branches are not writable through ordinary `github.commit.create`. They require the separate `github.protected-branch.commit` capability, which is registered as critical risk with strong approval. Pull-request merge is likewise a strong-approval capability.

### Analytics / data ingestion

`analytics.ingest.read` performs bounded HTTPS reads against a configured source, validates every row against the declared source schema, enforces tenant/environment binding, records source freshness, and hashes source URL, provider batch, payload, cursor lineage, dedupe key, and evidence record.

Cursor advancement and evidence insertion are committed atomically in PostgreSQL. The checkpoint store uses compare-and-swap semantics, request IDs are idempotent, and duplicate evidence keys are ignored rather than reinserted. A repeated durable Job cannot silently advance a cursor twice.

Ingested analytics are evidence only. The adapter result retains `jobStateMutationApplied: false`; analytics evidence/checkpoint tables are separate from authoritative control-plane entities and cannot establish Goal/Plan/Decision/Task/Job truth.

Real GitHub and analytics provider acceptance remains credential/provider gated. Static implementation or environment configuration does not mark either subsystem connected; only qualifying exact-SHA acceptance evidence can do that.
