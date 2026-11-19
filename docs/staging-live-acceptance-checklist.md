# GetDone staging live acceptance — operator checklist

Status: **NOT ACCEPTED**. This is a staging-only executable checklist, not a report of completed tests.
Candidate: PR #131 (`staging/getdone-unified-acceptance-20261014`). Pin one reviewed commit SHA for every staging service before testing. Do not use the production-oriented `render.yaml` as a staging blueprint.

## 1. Infrastructure inventory and release alignment

- [ ] Existing staging web: `getdone-web-staging`, Render ID `srv-db76v2l9fdbs73f8lngg`. Last observed live deploy: `6059b304c1fdbf69ecadd56267f58c87ea6e9926`; auto-deploy off. It is **not** currently running PR #131.
- [ ] Create **separate staging** `getdone-job-worker-staging` and `getdone-orchestration-worker-staging` in Oregon; do **not** edit existing `getdone-job-worker` and `getdone-orchestration-worker` (branch `codex/narrow-optimization-addendum`).
- [ ] Stage only the reviewed SHA on all three staging services. Build: `npm ci --include=dev && npm run build` (web), `npm ci --include=dev && npm run build:worker` (job), `npm ci --include=dev && npm run build:orchestration-worker` (orchestration). Starts: `npm run start`, `npm run start:worker`, `npm run start:orchestration-worker`.
- [ ] Separate staging DATABASE_URL, worker token, API keys and auth origin from production. Review environment variables / secret groups in Render's secure UI; **do not paste values in PR, logs or chat**. Verify `GETDONE_RUNTIME_ENV=staging`; role assignments `GETDONE_PROCESS_ROLE=web` / `job-worker` / `orchestration-worker`; verify remaining required role-specific env against the runtime startup validators. Web health is not proof workers are connected.
- [ ] PostgreSQL certificate verification: keep `GETDONE_DB_SSL=true`; provide validated CA PEM file using `PGSSLROOTCERT` where required, and ensure the certificate's hostname matches the DATABASE_URL host. Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0`, `PGSSLMODE=disable`, `sslmode=no-verify` or a TLS-bypass code change. Test each worker's database readiness and crash/restart behavior independently. Mark configuration **unknown**, not missing, until secure Render environment variables have been inspected.
- [ ] Confirm Render logs and deployment IDs for each staging service and all three source SHAs. Existing production services are out of scope.

## 2. Supabase staging preflight

Project: `ddxjiszbsmmbqxuoecmg`. Read-only checks last observed: one active user, one active owner membership, zero owner enrollment rows, zero WebAuthn credentials, zero authorization grants and consumptions, one backup evidence row; `getdone_schema_migrations` latest `2026-10-10.1`. Supabase migration history additionally includes `20261014200119` (`staging_verified_backup_runtime_read_policy`).

- [ ] Read-only recheck of owners/credentials/memberships, schema ledger, and the exact staging runtime role.
- [ ] Confirm sensitive auth and authorization tables enforce RLS and least privileges for the application runtime. `orchestration_worker_state` has RLS disabled, but last check showed no direct `anon` or `authenticated` SELECT. Review intended server-side role privileges/policies; do not enable RLS or modify grants without reviewing worker access first.
- [ ] Check staging-origin settings: `GETDONE_WEBAUTHN_RP_ID=getdone-web-staging.onrender.com`, allowed origins exactly `https://getdone-web-staging.onrender.com` per invitation issuer.
- [ ] Issue invitation **privately** using `scripts/issue-staging-owner-invitation.mjs` with secure staging DB connectivity and file permissions. Exactly one active owner is required. Invitation expires after 30 minutes. Never put the token or enrollment URL in chat, GitHub, logs or CI.
- [ ] Owner registers passkey on their own device, signs in again after restart and verifies session expiry/logout.

## 3. Isolated backup/restore acceptance (NOT yet executed)

Prerequisites: real backup `.dump` and private manifest, verified SHA-256, independent disposable PostgreSQL cluster with permissions to create isolated databases, verified TLS, supported `pg_dump`/`pg_restore`, and local build dependencies. Never run this against production or the staging application database server without independent proof that the test has an isolated disposable cluster and authorization. `database_backup_evidence` proves a backup was recorded, **not** that a restore succeeded.

- [ ] Verify supplied backup + manifest match, migration version equals release registry, and that the target restore database does **not** exist.
- [ ] For a synthetic integration test on the disposable cluster, run `scripts/test-staging-backup-restore.mjs` only with `GETDONE_RUNTIME_ENV=staging` and `GETDONE_ALLOW_ISOLATED_RESTORE_TEST=true`. The script creates a uniquely named source database and force-drops only that source database after it created it. Its called restore verifier creates and independently owns/cleans up its own target.
- [ ] For an independent restore of the **real** snapshot, use `scripts/restore-staging-backup.mjs` with `GETDONE_RUNTIME_ENV=staging`, `GETDONE_BACKUP_FILE`, `GETDONE_BACKUP_MANIFEST`, `GETDONE_RESTORE_ADMIN_DATABASE_URL` and a new `GETDONE_RESTORE_DATABASE_NAME` beginning with `getdone_restore_verify_`. This creates the target and fails closed when the target exists. Never set `GETDONE_RESTORE_KEEP_DATABASE=true` without an explicit cleanup plan.
- [ ] Verify component hashes, migration, authorization lineage, job state, receipt invariants, audit ledger, database readiness and successful `/api/control/health` boot of the restored app. Record redacted results and dispose of any retained target explicitly. No secrets or plaintext dumps in CI artifacts.

## 4. Conversation and governed execution scenarios (NOT yet executed)

For each scenario, capture: authenticated actor, tenant/business ID, request/trace ID, relevant timestamps, proposal ID, approval/denial ID, worker job ID and independent receipt. Keep sensitive payloads redacted.

1. **Natural-language continuity:** Ask `How's OpsManagerPro?`, then `Why?` and `What about marketing?`. Expect same authorized business retained, topic-sensitive evidence and no invented root cause.
2. **Business switch:** Ask `What about GetDone?`; expect old proposals, approval state and previous business's sensitive evidence cleared. Switching back requires fresh authorized evidence.
3. **Ambiguous execution:** With two proposed fixes ask `Fix that`; expect clarification. Choosing `first` selects a proposal but must **not** grant authority.
4. **Approved execution:** Request a safe staging-only action; verify preview/plan/policy, owner approval scope, exactly one authorization consumption, worker execution and independently verified receipt. Compare real external side effect to the receipt.
5. **Denied execution:** Reject an action in the owner inbox; verify no grant consumption, no worker side effect and a durable denial state after refresh.
6. **Tenant isolation:** Use two test tenants with separately authorized accounts; attempt to retrieve the other's evidence or reuse its approval/plan. Expect denial, no data leak and auditable rejection.
7. **Revocation/replay:** Revoke membership or consume an approval; retry the same action. Expect denial or idempotent no-duplicate execution. Never manufacture unrestricted privileges for the test.
8. **Recovery:** Restart a staging worker after queuing an approved non-destructive task; verify durable state, safe retry, no duplicate external effect and terminal receipt.
9. **Missing connection:** Ask for financial or marketing facts without relevant connection. Expect precise missing capability/connection explanation rather than fabricated data.
10. **n8n negative cases:** Invalid/missing signature, expired message, wrong tenant, unsupported capability, protected branch and preview hash mismatch must all fail closed with no action.

**Final launch gate:** Do not merge/deploy to production until these live results and independent restoration evidence are captured, failures remediated, and the operator explicitly approves release.
