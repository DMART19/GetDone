# Narrow GitHub launch

Scope: one owner/company; GitHub repository `DMART19/GetDone`; web, orchestration worker, job worker; PostgreSQL 16+. A configured integration is not evidence of an executed or verified Job. Global production readiness remains false until the full registered scope has real acceptance.

## Prepare and verify

Use Node 24 and the committed npm lockfile. `npm ci --include=dev --ignore-scripts`, then the repository static/security gates, tests, database acceptance and all three builds. `npm run build` now builds without installing or changing dependencies. Run migrations with separate administration credentials and certificate-verified TLS. Keep the restricted runtime role for services.

CI's PostgreSQL service uses `scripts/configure-ci-postgres-tls.sh` to generate an ephemeral certificate, enable TLS, verify it, and configure Node/libpq trust. This script is for disposable CI containers only. Production uses the database provider's certificate chain.

## First owner

Preserve an existing owner and enrolled passkey. Bootstrap enrollment cannot replace an existing credential, including a revoked one. Account recovery is a separate operator procedure.

For a new owner configure server-side `DATABASE_URL`, `GETDONE_RUNTIME_ENV=production`, `GETDONE_DB_RUNTIME_ROLE=getdone_tenant_runtime`, and the `GETDONE_OWNER_USER_ID`, `GETDONE_OWNER_ORGANIZATION_ID`, `GETDONE_OWNER_COMPANY_ID`, `GETDONE_OWNER_PORTFOLIO_ID` values. Set the final `GETDONE_WEBAUTHN_RP_ID` and exact HTTPS `GETDONE_WEBAUTHN_ORIGINS` first. Names are optional. Then:

```sh
npm run db:migrate
npm run production:bootstrap -- --enroll-passkey --invitation-file /private/path/owner-invitation.json
```

The output file must not exist. It is created with mode 0600 and contains a secret invitation URL valid for 30 minutes. Deliver it privately to the owner. Do not upload it as CI output or commit it. The browser removes the fragment from the address bar and never puts the invitation in a query string, cookie or local storage. Open the URL on the actual hostname, create the passkey, then sign in with the displayed user ID. Registration requires user verification; only the verified public key is persisted. It creates no session: sign-in proves possession of the new private key. A successful registration consumes the invitation atomically.

Reissue an expired or lost invitation by rerunning the command with a new private output path. This invalidates the previous invitation and its challenge. Once enrolled, the bootstrap path cannot reset the passkey. Delete private invitation files after use. The existing bootstrap mode accepting externally enrolled public-key metadata remains supported.

Web startup still requires the normal database/backup/AI/integration/monitoring configuration. Enrollment adds no bypass to the production startup gate. Run database/bootstrap administration before starting services; complete the owner ceremony once the web service is healthy.

## GitHub configuration and commissioning

Keep the App signing key on web/secure operator execution only. Workers receive the App/installation identifiers, provider reference and broker configuration. `GETDONE_GITHUB_ACTIONS_JSON` must contain one production connection scoped to the owner company, `repositories:["DMART19/GetDone"]`, and `protectedBranches:["main"]`. Keep the existing broker and worker secrets when present. Protect `main` on GitHub as well.

`GETDONE_GITHUB_CREDENTIAL_RESOURCE_IDS_JSON` must reference genuinely enrolled, ready, production-eligible resources in the same company/portfolio, with matching supported capabilities and `github-binding:<providerId>`. Do not fabricate ready resources or successful enrollment evidence. If none exist, perform the governed resource enrollment flow against the deployed worker/provider before applying the integration.

With owner identity, a real GitHub App installation, configuration and resources in place:

```sh
npm run production:commission-github
npm run production:commission-github -- --apply
```

The first command checks without database writes. It makes an App-authenticated GET confirming installation identity, suspension status and required permissions for the repository. It does not mint installation tokens or execute repository actions. `--apply` creates the matching integration and audit record transactionally; an identical existing record is accepted, conflicts/disabled records are not overwritten. Tokens for business execution remain governed by the existing job/approval/lease broker.

## Deploy on Render

Adopt the existing `getdone-web`; do not create a duplicate web service or Supabase project. `render.yaml` defines both workers and disables automatic deploys. Apply it through an authorized Render account and set secrets privately. Confirm the disabled auto-deploy setting on existing services: editing the file alone does not change Render.

1. Record current deployed commit/deployment IDs and check real backup restore evidence.
2. Run additive migrations before updating any service; verify schema, RLS and backup freshness.
3. Bootstrap/enroll the owner and commission the GitHub binding as described above.
4. Run the Production Release Gate for the exact merged candidate SHA. Do not enable automatic commit deploys to bypass it.
5. Deploy that same approved SHA to web, orchestration worker and job worker. Use the matching build/start commands in `render.yaml`.
6. Check web `/api/health`, authenticated `/api/control/health`, job worker `/readyz` on 3001 and orchestration worker `/readyz` on 3002 inside their private instances. Check persisted worker heartbeats.
7. Run an approved bounded GitHub action, verify it independently, and check the owner-visible outcome and backend telemetry. Record genuine evidence; do not promote local fixtures to production evidence.

Before migration, validate a rollback candidate against the new schema. The current startup verifier requires an exact migration version: an older binary can refuse startup even for an additive migration. Keep a tested rollback build that understands the new migration registry, or roll forward with a fix. Drain workers, preserve the database and secrets, and check lease recovery. Leave the owner-enrollment table in place; never delete real credentials or reverse schema changes as a code rollback shortcut.

## Acceptance boundaries

The first-owner PostgreSQL suite verifies genuine registration parsing/signature-based sign-in, invitation replay/expiry/reissue, origin/user-verification enforcement, and concurrency. The staging browser test uses a Chromium virtual authenticator to create a key through the real UI/API and sign in. Existing staging golden-path tests use a controlled local health adapter and explicit fixture orchestration. They do not prove live OpenRouter planning or live GitHub execution.

Live launch still needs secure Render/Supabase/OpenRouter/GitHub/collector access, an enrolled real resource, the owner's device ceremony, verified backup restore, a safe approved provider operation and production acceptance receipts.

## Local acceptance commands

Use a disposable PostgreSQL 16 database with TLS, Node certificate trust and libpq
certificate trust (`NODE_EXTRA_CA_CERTS`, `PGSSLROOTCERT`, `PGSSLMODE=verify-full`).
Set `DATABASE_URL`, `GETDONE_DB_SSL=true` and
`GETDONE_DB_RUNTIME_ROLE=getdone_tenant_runtime`. Run `npm run db:migrate` and
`npm run build:worker-acceptance`, then:

```sh
GETDONE_POSTGRES_INTEGRATION=true npm run test:coverage -- --no-file-parallelism
npm run verify:module-coverage
```

The CI coverage job provisions these prerequisites. Unit tests alone exclude the
PostgreSQL suites and do not satisfy the complete repository coverage gate.
Run browser suites after this command: disaster-recovery acceptance builds and
boots Next.js and must not share `.next` with a simultaneous development server.
Use a separate disposable database for `npm run test:e2e:staging`, with the
synthetic backup preflight documented in the browser workflow. Synthetic backup
preflight is only for the isolated browser fixture; restore acceptance performs an
actual local dump, restore and application boot. Neither supplies production backup
evidence.
