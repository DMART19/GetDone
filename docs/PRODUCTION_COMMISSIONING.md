# GetDone commissioning — 2026-10-07

**NOT READY.** Production evidence is separate from local acceptance. The source
baseline inspected was `d6d312a357d9fae4ca870da9f6a9c9462b1ec0f9` on `main`.

## Observed production state

- Render workspace `tea-db23uo17lnhs73dgv31g` (My Workspace) contains
  `getdone-web`, service `srv-db24imei0phs73d93p20`, targeting `main`.
- Deploy `dep-db2rkv61ilec73bgsf70` failed startup (`update_failed`). Build succeeded;
  runtime verification reported no governed production integration and no
  `GETDONE_OTEL_EXPORTER_OTLP_ENDPOINT`. Application logs are accessible.
- `https://getdone-web.onrender.com/api/health` returned HTTP 502.
- No job worker or orchestration worker was listed in that workspace.
- GitHub's branch API reported `main.protected=false`. GetDone's configured
  protected-branch restrictions do not establish GitHub-side branch protection.
- This execution environment has no production secret bindings. The connected
  Render tools can inspect deployments/logs but cannot read existing env values
  or create background workers. The owner reports an existing App and collector;
  their configuration has not yet been made available to this environment.
- Supabase migration, bootstrap, production passkey sign-in, OpenRouter calls,
  collector delivery, backups/restores, and a live governed GitHub operation have
  **not** been verified. No production success or backup evidence was created.

## Implemented

The existing broker now has a GitHub App delivery endpoint at
`/api/internal/credentials/github`. Only the dedicated job worker issues leases.
Before issuance and delivery, it re-reads the canonical persisted request, Job,
Task, authorization grant, current approval/step-up, integration, kill switches,
resource and active worker lease. Tenant RLS remains active. Broker authentication
alone cannot mint arbitrary credentials. Redemption is atomic and single-use.

Registration uses existing `SecretReference` and `CredentialBinding` objects,
scoped to the canonical owner company/portfolio. The initial repository is fixed
to `DMART19/GetDone`; merge and protected-branch commits are not registered.
GitHub permissions are selected by operation. The App key stays on the web
service; installation tokens exist only in delivery/worker memory. Provider
responses are checked for extra repositories and permissions. Audit records
contain lease/provider/job metadata and provider expiry, never token material.

GitHub installation tokens expire after approximately one hour; GitHub does not
offer an arbitrary shorter TTL here. GetDone's effective authorization expires at
the earlier grant/worker/credential lease deadline. Each token is revoked after
its provider call, including verification reads. Revocation failure emits
`credential.revocation.failed` (with a bounded retry) and leaves the one-hour
provider expiry as the backstop. Treat this event as a commissioning failure.
Cleanup/audit failure does not erase a persisted provider outcome or cause a
side effect to be repeated. Abrupt process death may also leave a token valid
until GitHub expiry; no token is persisted for later reuse.

Telemetry now redacts sensitive fields, recognized credential formats and known
configured secrets, uses bounded export requests, rejects redirects and partial
collector rejection, and emits rate-limited export-failure diagnostics. Counters
and single-observation histograms use delta temporality. `observability:canary`
tests HTTP/JSON acceptance for traces, metrics and logs and returns a trace ID for
independent backend lookup; HTTP acceptance alone is not backend visibility.

PostgreSQL TLS configuration prevents URL SSL options overriding certificate
verification. Production bootstrap, migrations, backup recording and database
verification use the same normalization. No migration or RLS changes are made.

`render.yaml` describes the existing web service plus the existing job and
orchestration worker implementations. It contains no Render database, generated
secrets, or App key sharing with workers. Worker build/start commands and generated
output exclusions are included. Schema validation passed against Render's public
2020-12 JSON schema; authenticated Blueprint application remains outstanding.

## Local verification

- Next.js production build, TypeScript checks, lint, job worker build and
  orchestration worker build passed during this pass.
- Full suite: 1,036 passed, 157 skipped, two existing admission-test assertion
  failures. Both failures reproduce on untouched baseline HEAD: fixture queries
  encounter missing objective authority before the integration error expected by
  the assertions. The production gate fails closed; these tests were not rewritten.
- Focused credential, GitHub adapter, telemetry, execution and TLS tests pass,
  including single redemption, denied approvals, tenant/resource/lease mismatch,
  protected main, excess scopes and provider response scope validation.
- Isolated local PostgreSQL 16 with certificate-verified TLS: all 28 migrations
  through `2026-09-28.9zz`, empty installation, upgrade, runtime-role/RLS checks,
  and authorization/lease/serializable concurrency races passed.
- 27 local PostgreSQL acceptance tests passed: bootstrap (4), passkey/auth (5),
  runtime verifier (3), queue/backpressure (3), multiprocess worker (7), and real
  process kill/restart at five execution boundaries (5).
- The verifier tests use explicitly local fixture backup evidence. These results
  are **not** real Supabase backup/restore evidence or production owner sign-in.

## Required access and exact configuration

Use secure environment configuration, not chat, source control or integration JSON,
for secrets. Preserve existing worker/broker tokens; do not rotate for this rollout.

| Requirement | Configuration/location | Why needed |
|---|---|---|
| Existing Supabase runtime connection and administration access for migrations if needed | Secure execution environment `DATABASE_URL`; existing Render web/worker runtime URLs. Provide migration credentials separately for migration commands. | Verify current schema, restricted role, TLS, RLS and real bootstrap. Do not use a superuser as the runtime login. |
| Existing bootstrap identities and passkey registration metadata | Secure execution configuration `GETDONE_OWNER_USER_ID`, `GETDONE_OWNER_ORGANIZATION_ID`, `GETDONE_OWNER_COMPANY_ID`, `GETDONE_OWNER_PORTFOLIO_ID`, `GETDONE_OWNER_PASSKEY_CREDENTIAL_ID`, `GETDONE_OWNER_PASSKEY_PUBLIC_KEY_PEM_B64` and optional algorithm/user handle. | Match the real tenant and owner; never invent replacement identities or passkeys. |
| Existing GitHub App installation | Render web: `GETDONE_GITHUB_APP_PRIVATE_KEY_PEM`. Web and workers: `GETDONE_GITHUB_APP_ID`, `GETDONE_GITHUB_INSTALLATION_ID`, `GETDONE_GITHUB_CREDENTIAL_PROVIDER_ID`, `GETDONE_GITHUB_CREDENTIAL_RESOURCE_IDS_JSON`. | Register the real App and eligible existing resource bindings. Install for **only** `DMART19/GetDone`; grant only the supported operation permissions, without branch-protection bypass. |
| Governed integration and broker connection | `GETDONE_GITHUB_ACTIONS_JSON` with company equal to `GETDONE_OWNER_COMPANY_ID`, the registered provider ID, `repositories:["DMART19/GetDone"]`, `protectedBranches:["main"]`; `GETDONE_CREDENTIAL_DELIVERY_URL=https://getdone-web.onrender.com/api/internal/credentials/github`; existing `GETDONE_CREDENTIAL_BROKER_TOKEN` (32+ characters). | Connect the adapter to authenticated delivery. The authoritative integration record must be genuinely connected, have `credentialBindingId=github-binding:<providerId>`, and `metadata.connectionId` equal the configuration ID. Existing resource records must include that binding and production/capability eligibility. |
| Collector endpoint, authentication and backend read access | Render services and secure execution environment: `GETDONE_OBSERVABILITY_ENABLED=true`, `GETDONE_OTEL_EXPORTER_OTLP_ENDPOINT`, `GETDONE_OTEL_EXPORTER_OTLP_HEADERS`. | Use the existing collector's HTTPS **OTLP HTTP/JSON base** URL (no `/v1/traces`, query or embedded credentials). Headers use `key=value` comma-separated entries, with URL-encoded values if needed. Collector must accept all three signals. |
| Existing AI and worker configuration | Secure execution configuration and corresponding Render services: `OPENROUTER_API_KEY`, existing primary/fallback profiles/routing, canary model, `GETDONE_INTERNAL_WORKER_TOKEN`. | Run genuine model/fallback/canary and worker acceptance without replacing established settings. |
| Render worker/environment administration | Secure execution environment `RENDER_API_KEY`, or authenticated Dashboard access to My Workspace. | Adopt existing web service and apply both always-on worker definitions without duplicating the web service. Connector currently has no worker-creation tool. |
| Protect main | GitHub repository Settings → Rules/Branches; protect `main`, forbid force push/deletion, and do not grant this GitHub App bypass. | Actual GitHub branch is currently unprotected. Connector does not expose branch-protection writes. |
| Real backup/restore evidence and rollback target | Supabase backup/restore access; GetDone backup evidence store; Render prior deploy history. | Obtain real recent backup and successful restore verification, then record it with existing tooling. No known-good live release was established in this pass. |
| Owner ceremony | Production `/sign-in`, using the owner's real enrolled passkey once runtime is healthy. | Complete explicit approval and chat → proposal → job → GitHub → independent verification. An automated test credential is not the owner's sign-in. |

## Resume and rollback

After secure access is available, inspect live state again; run `db:verify-production`
before any migration. Use `db:migrate` only if required, then deterministic
`production:bootstrap` against the existing identities. Check real backup/restore
evidence, run `verify:production-runtime`, the AI acceptance, and
`observability:canary`; look up its trace ID independently in the collector.

Adopt `getdone-web` and create workers from the Blueprint in My Workspace. All
three production gates must pass. Check web `/api/health` (liveness) and authenticated
`/api/control/health` (actual control-plane readiness). Check worker `/livez` and
`/readyz` from within each worker instance (ports 3001 and 3002 respectively), then
claims, heartbeats and a safe owner-approved branch operation through chat.

Before rollout, retain the exact previous web/worker deploy IDs and successful
health evidence. Follow [the narrow launch runbook](NARROW_LAUNCH_RUNBOOK.md) for
owner invitation enrollment, integration commissioning and this release's additive
migration. The startup verifier checks the exact migration version, so validate a
rollback build against the new schema before rollout; the old commit alone may
refuse startup. Preserve the database and secrets, drain workers and confirm leases
recover. Never run destructive down migrations as an application rollback shortcut.
