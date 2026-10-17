# GetDone — parallel owner + engineering staging launch checklist

**Version:** 2026-10-17 · **Status:** preparation only, no staging migration/deployment accepted.
**Integration PR:** #138 (`launch/unified-pilot-release-integration-20261017`) · **Pre-migration recovery PR:** #137 (`launch/staging-pre-migration-backup-restore-20261017`).
**Production is out of scope.** The repo-root `render.yaml` is production-oriented; never apply it as the staging deployment definition.

## Two workstreams

| Owner / secure access | Engineering / checks |
|---|---|
| Sign into the *shared* Render browser used for this task, then open the existing staging web shell. Do not send your password or Render cookies. | Complete CI on PR #138, review exact candidate SHA, keep all PRs draft and production unchanged. |
| Open the staging web service **Environment** privately and confirm `DATABASE_URL` references Supabase **ddxjiszbsmmbqxuoecmg** only. Never paste the URL/password. Confirm effective env group/overrides; the named group alone does not prove isolation. | Use Render/Supabase read-only tools to verify metadata, backup age, migrations, role policies, deploy SHA and worker inventory. |
| Confirm a real, trusted `PGSSLROOTCERT` file exists in the **private** staging shell and `PGSSLMODE=verify-full` with `GETDONE_DB_SSL=true`. | Run `node scripts/verify-staging-runtime-config.mjs` then `--connect` from the staging shell after credentials/CA are confirmed; never disable TLS. |
| Provide a private volume for the real PostgreSQL dump and manifest, **a second independently managed disposable PostgreSQL server** with verified local TLS (not Supabase), and secure storage for the retained copy. | First run PR #137's pre-migration `2026-10-10.1` backup ceremony against the live staging source, verify both independent restores and exact retained SHA, store only redacted hashes/report as evidence. |
| Review the redacted recovery proof and separately approve applying staging-only migrations `2026-10-17.1` and `2026-10-17.2`. | Once approved, review/dry-run the exact migration order, use the standard staged migration mechanism, re-run auth/worker RLS preflight, and re-back-up/re-restore post-migration. |
| Keep the previously approved maximum **two starter staging workers, $14/month combined**; confirm no additional paid services are necessary. | After database/CA/security gates pass, prepare `getdone-job-worker-staging` and `getdone-orchestration-worker-staging` on the same passing SHA, Oregon, auto-deploy off. Never repurpose suspended production-linked workers. |
| Enroll your own WebAuthn passkey when the staging app is healthy. Invitation must remain private and single-use. | Verify a real owner session, logout, step-up, company selection, and denial of cross-tenant access. |
| Provide an authorized staging **owner/repository** and **source branch** for the first GitHub branch-creation action; don't send credentials. Connect OpenRouter and n8n **inside their private configuration UIs**. | Import the **inactive staging** n8n workflows, configure staging-only scoped credentials, then validate read-only evidence and one user-approved GitHub branch creation with independent GET-SHA verification, replay/denial/restart recovery and audit. |

## 1. Owner: Restore private Render access

Open [staging web shell](https://dashboard.render.com/web/srv-db76v2l9fdbs73f8lngg/shell) in the authorized shared cloud browser. Our last browser check reached the Render sign-in screen; being logged into a separate ordinary browser does not necessarily authenticate the shared browser. After signing in yourself, tell us **“Render staging shell ready.”**

In Render, open `getdone-web-staging` → **Environment**, check the names privately (never values): `DATABASE_URL`, `GETDONE_RUNTIME_ENV`, `GETDONE_DATA_MODE`, `GETDONE_DB_SSL`, `GETDONE_DB_RUNTIME_ROLE`, `PGSSLROOTCERT`, `GETDONE_INTERNAL_WORKER_TOKEN`. Confirm `GETDONE_RUNTIME_ENV=staging`, `GETDONE_DATA_MODE=authoritative`, `GETDONE_DB_SSL=true`, `GETDONE_DB_RUNTIME_ROLE=getdone_tenant_runtime`, and that the database project ID is **ddxjiszbsmmbqxuoecmg**. If the secret is masked and the database identity cannot be checked without revealing it, mark it unverified and use the private preflight command in the shell instead.

**No need to copy or share secret values.** Only report “staging database confirmed” after checking the **effective** service value or a successful scoped connection test. The CA PEM file must be available at the actual `PGSSLROOTCERT` filesystem path on web and later both staging workers; an env variable pointing to a nonexistent file is insufficient.

## 2. Owner: Genuine backup + independent restore

The staging database currently runs schema **`2026-10-10.1`**. For the **pre-migration backup**, run the private recovery ceremony using PR #137's pinned branch, **not** PR #138's post-migration `2026-10-17.2` registry. Operator instructions: `docs/staging-pre-migration-backup-recovery-20261017.md`.

This must be a real `pg_dump` of the staging project, with SHA-256 verified against a private stored copy, followed by restoration to a separate disposable PostgreSQL server, independent audit/domain checks, and successful restored-application startup. A GitHub Actions disposable fixture test is **not** a backup of the live staging data.

The old `database_backup_evidence` record (October 14) is stale. Do not update it by hand, forge timestamps, disable maximum-age limits, or use source staging as the restore target.

## 3. Owner: Decide on staging-only migrations

Only after the real recovery ceremony passes: inspect the reviewed SHA and the two migrations, then explicitly approve **staging only**. Neither a green CI result nor previous worker-spend authorization approves schema changes.

The expected migration order is `2026-10-17.1_auth_runtime_boundary.sql` **then** `2026-10-17.2_worker_rls_scoped_dispatch.sql`, under existing `getdone_schema_migrations` ordering. The unified candidate release registry requires `2026-10-17.2`. Re-run the private `--connect --workers` preflight, then take and restore an additional **post-migration** backup.

## 4. Owner: Passkey, AI and one safe test action

When the staged web becomes healthy, use the private staging invitation process to enroll your own passkey on your own device. The invitation and passkey ceremony are not operations an assistant can impersonate.

Prepare your authorized **staging/test repository** and **source branch** for the first GitHub branch-creation action. A non-protected branch and separately scoped GitHub App credentials are required. Separately connect an OpenRouter API key and three **staging-only, initially inactive** n8n workflows. Keep the n8n signing key and GitHub credentials private.

Do not enable the write workflow until signed validation, authenticated approval, worker readiness, and read-only n8n checks all pass. The first permitted side effect will be one unique branch in the approved test repository. The final receipt must be verified by an independent GitHub GET, not merely an n8n success response.

## 5. Engineer: acceptance and release record

- **Code-gated now**: `npm ci`, targeted conversation/business/n8n and role tests, full Vitest, job/orchestration worker builds, typecheck, lint, Next.js build, architecture/secrets checks, migration policy, desktop/mobile Playwright, and disposable PostgreSQL backup/restore.
- **Live-gated later**: exact same SHA on web + both staging workers, current verified TLS, fresh genuine pre/post-migration backup/restore, real passkey owner session, real data continuity and business switch, preview/approval/denial, one n8n side effect and independent GitHub receipt, replay and cross-tenant rejection, worker stop/restart recovery.

For each live test record redacted run IDs, approved scope, timestamps, input hash, approval ID, worker job ID, external branch/ref+SHA, independent receipt, and failure/recovery results. Keep actual credentials, tokens, private dumps, enrollment links and raw secrets out of chat and PRs.

**Do not mark GetDone production ready because CI is green.** The owner-only pilot may pass only after the real live evidence is independently reviewed. Production release remains a separate authorization and acceptance process.
