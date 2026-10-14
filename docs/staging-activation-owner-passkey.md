# GetDone staging: activate and enroll owner

**Only staging**. Production is out of scope. This integration is PR #129 based on the currently deployed staging conversation engine.

## Verified preflight (2026-10-14)

- Render web service `srv-db76v2l9fdbs73f8lngg`: `https://getdone-web-staging.onrender.com`; deployment pinned to `codex/frontend-backend-integration-pass`, SHA `0ba47ee42b565186129a656c9c76efef9398476c`. Auto-deploy is off.
- Both job and orchestration workers are live on `codex/narrow-optimization-addendum`, SHA `c991acaa39f39bc9759c5d111daf51d7c321605a`; do not change their code without a compatibility audit.
- Supabase staging ref `ddxjiszbsmmbqxuoecmg`, schema migration `2026-10-10.1`, one active owner but zero registered credentials/invitations.
- Two additional staging-only businesses and portfolios have been created with active owner memberships.
- **STOP: staging web instrumentation currently reports missing/stale backup verification evidence.** The staging `database_backup_evidence` table has zero verified rows. A Render “live” deployment does not satisfy startup readiness.

## Step A: create a real staging backup and verify it

Use a computer or a private administrative runner with Node 24, npm and `pg_dump` for PostgreSQL 17. Work on the reviewed staging integration branch. Set `GETDONE_RUNTIME_ENV=staging`, the **staging-only** `DATABASE_URL` and trusted TLS root certificate securely. Do **not** paste these values in chat or logs.

```bash
npm ci
export GETDONE_RUNTIME_ENV=staging
export GETDONE_BACKUP_FILE="$HOME/getdone-staging-20261014.dump"
npm run db:create-staging-backup
```

The existing `scripts/create-staging-backup.mjs` creates the actual `pg_dump` file and integrity manifest, then records verified evidence. **Retain both files in a protected, durable owner-controlled location before accepting readiness**. Never run `db:record-backup` with invented SHA or disable the backup gate. Re-check staging startup after the backup operation.

## Step B: reconcile and deploy staging-only candidate

Review draft PR #129; require CI passes including Node syntax check, TypeScript, build, architecture/secrets and Playwright. Confirm the candidate does not change database/workers/auth security logic. Advance only the staging web source branch through the reviewed commit (or change branch in Render to its verified exact SHA) and manually trigger the staging web deploy; auto-deploy is off. Keep worker releases pinned unless a tested compatibility change is required. Verify deployed SHA, startup logs and `/api/health` before owner enrollment. Configure `GETDONE_DAVID_EDITION=true` on staging web only if approved. Confirm WebAuthn RP `getdone-web-staging.onrender.com`, origin `https://getdone-web-staging.onrender.com`, secure cookies.

## Step C: obtain private single-use invitation

The only legitimate enrollment path is an owner invitation followed by a browser/WebAuthn ceremony. Never generate an artificial credential. **After** the HTTPS staging site is healthy:

1. Open Supabase Dashboard → project **GetDone Staging** (`ddxjiszbsmmbqxuoecmg`) → SQL Editor, privately.
2. Open and review `scripts/issue-staging-owner-invitation.sql` from this exact integration branch, then run it **in the GetDone Staging SQL Editor only**.
3. It returns a private `https://getdone-web-staging.onrender.com/setup/owner#...` link expiring after **30 minutes**. The link is a bearer invitation. Do **not** paste, screenshot, share or commit it. Run again for a fresh invitation if expired before use.
4. Open the returned URL on your own iPhone (prefer Safari), tap **Create owner passkey**, complete Face ID / iCloud Keychain or the chosen security key, then go to `/sign-in` and authenticate using that newly created passkey.

Alternatively, in a trusted terminal with staging DB credentials you can run:
```bash
GETDONE_RUNTIME_ENV=staging GETDONE_WEBAUTHN_RP_ID=getdone-web-staging.onrender.com GETDONE_WEBAUTHN_ORIGINS=https://getdone-web-staging.onrender.com node scripts/issue-staging-owner-invitation.mjs --invitation-file "$HOME/getdone-staging-invite.json"
```
Read the URL locally from the private file. This must never be pasted into chat.

## Step D: owner acceptance after sign-in

Select Sacramento Party Rentals — STAGING TEST. Ask “What's happening with this business?” then “Why?” and “What about marketing?”. Start another thread; refresh; verify that messages and contexts remain scoped. Select Junk Hauling — STAGING TEST and verify separation. Only approve a harmless, reversible staging action. Examine the actual worker transition, audit correlation, external sandbox outcome and **independent** verification evidence. A typed message or UI toast never proves an external operation completed.

## Red flags / release STOP

- Missing verified actual backup, no HTTPS origin match, any passkey verification failure.
- Tenant/portfolio record leakage, approval bypass, duplicate external effect, false “verified” UI, missing audit/verification receipt.
- Unsupported worker deployment mix, unreviewed environment changes or a code SHA not matching the tested candidate.

No deployment to production. No assertion of production readiness without full observed staging acceptance.
