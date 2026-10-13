# Narrow operational release

Based on PR #122 (`dbad5fdf93b7a677cddc772ee3836d22be674925`). No merge, deployment, database migration, or live provider action is part of this implementation handoff.

## Runtime boundaries

`lib/operations` adds tenant/environment/user-scoped capability discovery, durable decision inbox projections, normalized evidence, deterministic action previews, scheduled objective evaluation, receipt-linked outcome ranking, and compact answer footers. Records use the existing RLS-protected `control_plane_entities` store. Existing decisions, grants, consumption records, job workers, credential broker, and independent verification remain authoritative.

Enable `GETDONE_N8N_ENABLED=true` for the narrow release. In this mode both planning validation and the adapter registry restrict execution to `github.repository.read`, `http.request` (registered deployment health only, empty payload), and `github.branch.create`. No marketing, CRM, email, publishing, or other provider workflow is registered. Legacy integrations remain available only outside this mode to preserve PR #122 behavior. Composio and Langfuse are not installed, initialized, or required; no optional integration is enabled by this work.

The three inactive workflow exports are:

- `n8n/github_repository_health.json`
- `n8n/deployment_health.json`
- `n8n/github_create_branch.json`

Repository health synchronizes source-branch SHA and health facts. Deployment health synchronizes registered read-only health facts. Branch creation requires a preview containing `expectedSourceSha`; it neither changes files nor merges or deploys. The GetDone adapter checks the source SHA before dispatch and independently reads the resulting GitHub ref afterward. Workflow success alone is not verification.

## Configuration (do not enable without staging validation)

Keep existing Supabase/Postgres, OpenRouter, native GitHub credential-broker and worker configuration. Additional GetDone settings:

- `GETDONE_N8N_ENABLED=true`
- `GETDONE_N8N_SIGNING_KEY`: at least 32 characters; provision through the secret manager, never commit it.
- `GETDONE_N8N_GITHUB_WORKFLOWS_JSON`: array of `{connectionId, portfolioId, companyId, environment, repositoryHealthUrl, createBranchUrl}`. URLs must be credential-free HTTPS without query strings or fragments.
- `GETDONE_N8N_DEPLOYMENT_WORKFLOWS_JSON`: array of `{portfolioId, companyId, environment, operation, connectionId, workflowUrl}`. Only this named operation and an empty input payload are permitted.
- `GETDONE_GITHUB_ACTIONS_JSON`: existing GitHub configuration and repository/protected-branch allowlists. Brokered GitHub credentials are retained by GetDone for independent verification, not sent in workflow envelopes.
- Leave `GETDONE_HTTP_ACTIONS_JSON` unset in narrow mode; arbitrary HTTP actions are rejected.
- Optional `GETDONE_OBJECTIVE_EVALUATOR_USER_ID`: owner identity whose active memberships are rechecked each tick.
- Optional `GETDONE_OBJECTIVE_EVALUATION_INTERVAL_MS`: defaults to 300000, minimum 60000.

On a trusted, isolated n8n installation, import the three exports without renaming them, select narrowly scoped stored provider credentials, configure `GETDONE_N8N_SIGNING_KEY` and `GETDONE_N8N_ALLOWED_SCOPE_JSON`, and inspect each guard before activation. The latter contains the exact portfolio/company/environment/connection scope, repository allowlist/protected branches, and deployment operation/fixed deployment URL expected by the guard. Code nodes require access to the built-in `crypto` module and these specific environment values. Do not weaken secret isolation on a shared untrusted n8n instance. Workflow execution persistence is disabled in the exports to avoid retaining sensitive envelopes. No credential IDs or secret values are bundled.

Register `operational-connection` records using the strict `connectionSchema` through a trusted tenant-scoped provisioning path: `id`, `portfolioId`, `companyId`, `environment`, `provider`, `status`, `resources`, `grantedUserIds`, `workflows`, `updatedAt`, optional `expiresAt`, and `sensitivity`. These records describe access; they do not grant credentials or override native policy. Keep status and grants synchronized with actual integration health. There is no new public provisioning endpoint.

Register `objective-metric` records with tenant/environment plus `objectiveId`, `topic`, numeric fact `key`, finite `target`, and `operator` (`gte` or `lte`). The scheduler reads evidence already synchronized by the two health workflows; it does not independently dispatch provider jobs or create authorization. It writes local evaluations, recommendations/inbox projections and receipt-linked outcomes only. A separate authorized read refresh must keep evidence fresh; stale/missing evidence becomes an owner-input recommendation.

## Approval, retrieval and learning

Preview fields come from validated capability parameters, a scoped registration, and native policy artifacts. SHA-256 binds the entire preview to the approval proof. Dispatch resolves the persisted decision/grant/consumption and reconstructs the preview against current registration. Parameter, resource, scope, expiry, and hash changes fail closed. The branch minimum is explicit approval; stronger native requirements remain effective.

Evidence retrieval checks integrity, tenant, environment, user provenance, sensitivity, resource, topic, freshness, and current connection access before ranking. Shared normalized facts also feed planner context. Footers contain aggregate freshness/confidence and safe links, never provider payloads or credential provenance.

Outcome capture joins independently verified jobs to approved previews, plan findings/recommendations, execution receipts and verification receipts. Objective impact starts as unknown. Only an explicitly objective-linked plan with comparable persisted measurements before verification and freshly synchronized evidence after verification can acquire measured impact. This is observed association, not proof of causality. Positive verified history gives a bounded ranking boost; it has no policy, approval, tenant or resource-allowlist mutation path. Optional owner feedback is part of the contract; no feedback UI is added.

## Acceptance and release gate

Run `npm test -- --no-file-parallelism`, `npm run typecheck`, `npm run lint`, `npm run verify:architecture`, both worker builds, and `npm run build`.

`lib/operations/acceptance.test.ts` covers the addendum's authorization, connection, preview mutation, normalization, read-only evaluation, ranking, business switching, degradation and footer cases. `n8n-acceptance.test.ts` exercises signed dispatch, independent GitHub verification, replay behavior, source drift, parameter mutation, deployment read constraints and workflow guards using controlled transports. These are local acceptance tests, not proof of a live n8n run.

Before expanding provider coverage, staging must demonstrate the complete conversation → investigation → explanation → recommendation → preview → explicit approval → execution → independent verification loop with all three imported workflows and real scoped credentials. Also run Postgres/RLS integration tests, worker restart/replay checks and business switching against the staged database. Record preview, decision, execution and verification hashes. Neither the workflow exports nor the feature flag should be enabled in production on the strength of mocked transport tests alone.

Known operational setup still required: trusted connection/metric provisioning and health-state refresh, evidence-read scheduling, real n8n import/runtime validation, and live database/provider acceptance. No additional provider workflow should be added until that gate passes.

Local validation on this branch: 1,282 tests passed, 166 environment-dependent tests skipped; the 20 addendum-specific tests passed. Type checking, lint, architecture checks, both worker builds and the Next.js production build passed. Skipped database/staging tests are not acceptance evidence. Workflow transport failures persist degraded health without overwriting connection grants; recovery and expiry monitoring still require the trusted integration-health provisioning path.
