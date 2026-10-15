# GetDone staging integration acceptance (2026-10-14)

This branch starts from staging/david-edition-conversation-integration at 6059b304c1fdbf69ecadd56267f58c87ea6e9926. It includes the ancestor codex/narrow-optimization-addendum worker code (c991acaa39f39bc9759c5d111daf51d7c321605a). Do not cherry-pick that ancestor again.

## Release scope and guardrails
- Staging only; do not modify or deploy production.
- Web and both workers must build from this **same commit**. Existing workers currently track the older ancestor branch and cannot be considered release-compatible without redeployment and validation.
- Do not enable consequential n8n actions until authenticated approval, idempotency, execution and independent verification gates pass.
- Do not weaken RLS, TLS, passkey, or approval requirements.

## TLS startup blocker
Both worker logs on 2026-10-14 reported DATABASE_READINESS / SELF_SIGNED_CERT_IN_CHAIN. The existing lib/persistence/postgres/tls.ts accepts PGSSLROOTCERT pointing to a readable PEM CA bundle and uses rejectUnauthorized:true. Configure the correct Supabase CA chain through a trusted secret file mounted at an **identical valid path on each worker**, then set PGSSLROOTCERT to that path; or use an operator-verified Node trust bundle via NODE_EXTRA_CA_CERTS available before process startup. Confirm the database hostname and certificate chain. Never use NODE_TLS_REJECT_UNAUTHORIZED=0, sslmode=no-verify, or rejectUnauthorized:false. No certificate or secret is stored in this repository.

## Staging-only acceptance
1. Verify the staging database backup using the existing db:create-staging-backup process and independently inspect evidence before deploying a candidate.
2. Build and test this exact commit: npm ci; npm run typecheck; npm run lint; npm test; npm run verify:architecture; npm run verify:secrets; npm run build; npm run build:worker; npm run build:orchestration-worker.
3. Run Playwright UI/browser tests, including mobile, auth, tenant isolation and conversational continuity. The David Edition v37 standalone 3D source assets are not fully integrated; do not report them as complete.
4. Configure a separate staging worker deployment for each role, from the same reviewed SHA as staging web, with staging database credentials, correctly mounted trust bundle, and no production credentials. Do not repoint existing production workers.
5. Confirm all worker runtime verifiers pass and processes stay alive; check logs and health. An HTTP 200 /api/health alone is insufficient proof of provider readiness.
6. With a staging owner passkey, test creating/selecting two business planets, natural language continuity, tenant isolation, real evidence retrieval, owner decision inbox, preview, approval, authorized execution, independent receipt verification, restart recovery, and negative authorization cases.
7. Validate GitHub and n8n workflows with explicit allowlists and dry-run or safe staging targets. No live consequential actions without owner approval.
8. Record exact SHA, environment, timestamps, logs, CI/browser results, pass/fail evidence, and unresolved blockers. Do not merge or promote to production until every gate passes.

## Known gaps
- Existing workers' latest observed runtime failure: certificate chain trust.
- Current staging web and workers run different SHAs.
- Staging passkey enrollment, verified backup, and end-to-end execution acceptance are not established.
- Full standalone v37 planetary scene integration remains incomplete.
