# GetDone owner-only staging activation — six fail-closed gates

**Runbook status: prepared, NOT EXECUTED.** Linked change chain: PR #132 (staging TLS, n8n and worker hardening) then draft PR #134 (auth/RLS boundary). Do not merge either into production or apply `render.yaml` to staging. The staging web is pinned to a different, older branch until explicitly redeployed.

## Verified read-only state (2026-10-17 UTC)

- Supabase staging project: `ddxjiszbsmmbqxuoecmg` (active/healthy). Latest genuinely recorded `database_backup_evidence` completion: **2026-10-14 19:46:36 UTC**, too old for the default 24-hour readiness gate.
- Owner records: 1 active auth user, 3 existing memberships and **no WebAuthn credentials**. Staging auth migration `2026-10-17.1` has **not** run and `getdone_auth_runtime` does not yet exist.
- Render web `getdone-web-staging` (`srv-db76v2l9fdbs73f8lngg`) still deploys `staging/david-edition-conversation-integration`, not the unified candidate. Latest application logs return `503` for stale database-backup verification. The existing `getdone-job-worker` and `getdone-orchestration-worker` are **production-linked, suspended, and excluded**.
- Dedicated staging workers `getdone-job-worker-staging` and `getdone-orchestration-worker-staging` have not been created. No associated charges authorized beyond the previously approved two $7/month starter workers ($14/month combined maximum).

## 1. Security review / migration gate

1. Independently review `migrations/2026-10-17.1_auth_runtime_boundary.sql`, `lib/persistence/postgres/auth-runtime.server.ts`, `lib/persistence/postgres/client.ts`, `lib/auth/owner-enrollment.server.ts`, and `lib/security/rate-limit.server.ts`. Confirm no auth role business-table access, no unauthenticated public grants, no BYPASSRLS, no direct role-changing user input and no privilege escalation.
2. Require the exact PR #134 head to pass GitHub Actions `isolated-auth-rls` against disposable PostgreSQL and all configured `integration-gates`. The unit tests do not replace owner WebAuthn testing or a real credential-based TLS test.
3. Obtain a **genuine source backup** with the currently deployed migration version **before** applying the new DDL. Independently restore that backup to a separate disposable PostgreSQL server using the repository's `scripts/restore-staging-backup.mjs` with a `getdone_restore_verify_...` target and verified CA. Verify snapshot hashes, audit ledger, domain invariants, application bootability, and record a redacted restore report. Do not restore into GetDone Staging.
4. Apply the reviewed migration **staging only** using the standard migration system and an administrator-approved connection, then pin the web and future staging workers to the same passing candidate SHA. The new release registry requires migration version `2026-10-17.1` so a missing migration must fail closed.
5. Re-take a fresh genuine post-migration backup with the new registry and independently restore it. Preserve backup artifacts in approved private storage; never paste them or connection strings into chat, commits, CI artifacts or logs.

## 2. PostgreSQL TLS and connection identity

Configure via Render's private environment UI (not repository files): staging-only `DATABASE_URL`, `GETDONE_RUNTIME_ENV=staging`, `GETDONE_DATA_MODE=authoritative`, `GETDONE_DB_RUNTIME_ROLE=getdone_tenant_runtime`, `GETDONE_DB_SSL=true`, `GETDONE_INTERNAL_WORKER_TOKEN` and `PGSSLROOTCERT` pointing to a **real file** containing a trusted certificate chain on each relevant service.

Run `node scripts/verify-staging-runtime-config.mjs` first, then `node scripts/verify-staging-runtime-config.mjs --connect` **inside each staging service's private shell**. **Before purchasing either worker**, run `node scripts/verify-staging-runtime-config.mjs --connect --workers` from the staging web's private shell. This read-only catalog check fails if job/worker runtime tables have no effective grants or tenant-role RLS policies. It does not prove real worker DML or tenant isolation; those still require disposable PostgreSQL integration tests. See P0 issue #135. The network mode requires the exact approved staging database project, authenticated and CA-verified Postgres TLS, visible owner/membership rows via the restricted auth role and denial of unscoped auth reads via the tenant role. Never disable certificate verification or infer TLS success from static configuration.

Confirm staging Render env group `getdone-staging-runtime` points to staging credentials only and reconcile duplicate keys on the web service *privately*. Do not link an unverified environment group to any new worker.

## 3. Dedicated staging background workers

Create only after gates 1 and 2, and only within the owner's existing ~$14/month total approval; use Oregon, Node, starter plan ($7/month each), auto-deploy **OFF** and the exact same reviewed SHA as staging web.

| Service | Build command | Start command | Required role / port |
|---|---|---|---|
| `getdone-job-worker-staging` | `npm ci --include=dev && npm run build:worker` | `npm run start:worker` | `GETDONE_PROCESS_ROLE=job-worker`, `GETDONE_JOB_WORKER_HEALTH_PORT=3001` |
| `getdone-orchestration-worker-staging` | `npm ci --include=dev && npm run build:orchestration-worker` | `npm run start:orchestration-worker` | `GETDONE_PROCESS_ROLE=orchestration-worker`, `GETDONE_ORCHESTRATION_WORKER_HEALTH_PORT=3002` |

Use unique staging worker IDs, the approved staging token, appropriate environment settings and an identical trusted CA file. Both must pass their real startup/readiness and one worker stop/restart recovery test. Never modify, unsuspend, or charge the production-linked workers.

## 4. Real owner passkey

After staging web is healthy and the migration is applied, an authorized operator may use `scripts/issue-staging-owner-invitation.mjs --invitation-file <private-path>` in the private staging shell. The script requires exact staging RP ID and HTTPS origin and creates a **single-use**, short-lived invitation in a mode-0600 local file. The owner must open the invitation on their own device and personally enroll the hardware/platform passkey.

Prove a real sign-in, session persistence, logout/revocation, step-up and repeat login. Do not insert fake credentials or claim that test fixture keys are owner passkeys. Never share the invitation URL or QR/token in chat, GitHub or logs.

## 5. n8n isolated acceptance

Generate **inactive** staging workflow imports with `node scripts/export-staging-n8n.mjs <empty-output-directory>`, inspect their distinct webhook paths and staging-only validator. Follow `docs/staging-n8n-import.md`. Configure a staging-only GitHub repository/branch credential and signing key before enabling. `GETDONE_N8N_ENABLED` must stay `false` until the owner is authenticated, the workers are healthy and the workflows have passed signed read-only tests.

## 6. Owner approval → execution → independent result

Under the owner's real passkey session, test the complete chain `Understand → Investigate → Propose → Approve → Execute → Verify → Record`. Run one read-only GitHub health question, then one owner-approved branch creation in the designated staging/test repository and source SHA. Verify the **actual branch SHA** through an independent GitHub GET; also prove denied/expired approvals cannot execute, replay does not double-execute, a foreign tenant is rejected and both staging workers recover after restart.

Capture the actual run IDs, relevant evidence hashes and redacted logs. CI mocks, successful job submission, and Render showing `Deployed` are **not** proof of independent execution success.

## Promotion decision

All six gates must have independently verified PASS evidence on one pinned SHA. Until then, keep PR #134 draft, auto-deploy off, both existing production-linked workers untouched, and GetDone classified as **not yet owner-only accepted**.
