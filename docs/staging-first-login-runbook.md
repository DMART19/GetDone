# GetDone first-login staging acceptance runbook

**Source:** draft PR #128, branch `feature/david-edition-production-refinement`. **Production remains untouched.**
**Environment:** isolated, authoritative staging only. No real customers, no production OAuth credentials, no production worker mutation.

## Phase 0 — deployment prerequisite (administrator, before owner login)

As inspected 2026-10-14 in Render workspace `tea-db23uo17lnhs73dgv31g`:
- `getdone-web-staging` (`srv-db76v2l9fdbs73f8lngg`), URL `https://getdone-web-staging.onrender.com`, currently follows `codex/frontend-backend-integration-pass` with auto-deploy **off**.
- `getdone-orchestration-worker` (`srv-db6qsgon74is738lpj70`) and `getdone-job-worker` (`srv-db6qsgon74is738lpj6g`) follow `codex/narrow-optimization-addendum`; auto-deploy **off**.
- Consequently **the new conversation changes are not running on the staging URL yet**. Don't mistake an old build for the new branch.

1. Finish PR CI and review the exact candidate SHA. Before deploying, reconcile web and worker versions: confirm contracts/migrations are compatible across the candidate and both worker branches. Do not blindly repoint workers or deploy to production.
2. In Render, choose **getdone-web-staging**, select only the reviewed staging candidate (or staging integration branch containing it) and manually deploy that **exact commit SHA**. Ensure `GETDONE_RUNTIME_ENV=staging`, `GETDONE_DATA_MODE=authoritative`, `NEXT_PUBLIC_APP_ENV=staging`, `GETDONE_DAVID_EDITION=true`, and appropriately scoped `GETDONE_CONTROL_API_URL`, `DATABASE_URL`, TLS/certificate, WebAuthn RP ID/origins and staging-only integration secrets. Never share secret values in chat.
3. On the same staging topology, verify the orchestration/job workers are healthy and built from compatible reviewed SHAs. Do not use production workers or live external actions.
4. Wait for healthy deploy and matching SHA. Verify the staging WebAuthn RP domain matches `getdone-web-staging.onrender.com` (or a dedicated staging domain), origin uses HTTPS, and cookies are Secure. Do not use the localhost HTTP WebAuthn config on the hosted Render service.
5. Provision two **staging-only** portfolios (A and B), one owner with active memberships in both and a second test user with access only to A. Enroll staging passkeys via `/setup/owner` with administrator-provisioned invitations. Create one harmless reversible sandbox job/decision for later acceptance; do not pre-approve it.

## Phase 1 — pre-login checks (no credentials)

Open `https://getdone-web-staging.onrender.com/api/health` and verify the endpoint responds. On a machine with Node 24/npm 11 and a checked-out reviewed staging candidate:

```bash
npm ci
npm run typecheck
npm run lint
npm run build
npm run verify:architecture
npm run verify:secrets
npx vitest run lib/conversation/continuity.test.ts lib/conversation/business-routing.test.ts lib/persistence/postgres/owner-intent-history.test.ts lib/control-api/postgres-auth.test.ts lib/control-api/http.test.ts
```

For isolated authoritative DB security probes from that checkout (requires correct **staging** `DATABASE_URL`, role and TLS; doesn't authenticate an owner):

```bash
npm run test:e2e:staging -- e2e/staging/david-edition-security.spec.ts
```

This test config starts a **local staging-mode web server** on port 3200 against the configured staging DB; it is *not* a test of the Render deployment itself. Run it only with explicitly authorized staging credentials and TLS configuration. If config is absent, skip and report a blocker rather than setting insecure production-like fallbacks.

## Phase 2 — first login, browser (owner A)

1. Navigate to `https://getdone-web-staging.onrender.com/sign-in`. Authenticate with the enrolled staging passkey; if no enrollment, use `/setup/owner` with an administrator-provisioned owner invitation.
2. Confirm the David Edition universe displays both authorized staging businesses A and B. Open the multi-business composer, select **A**.
3. Click **New conversation**. Send: `How is GitHub connected for Business A?` (use the exact configured integration/business names). Confirm it reports evidence or explicitly says unknown; it must not invent connection health.
4. Send: `Why?` and `What about marketing?`. Verify the context remains A and any factual answer cites or reflects A-only evidence. If GetDone cannot resolve the reference, a clarification is a valid safe result.
5. Send: `Fix that`. The system must **not** execute based solely on conversation memory; it should request a proposed action/approval. No worker side effect should appear.
6. Click **New conversation** again; send an unrelated question (e.g., `What is the objective status?`). Switch between the two threads. Neither should inherit the other's topic. The saved thread labels are derived from the first question.
7. Refresh the page, sign out, and sign in again. Both threads should reappear, with message history and persisted final answers/available lifecycle snapshots. Do not expect every intermediate progress update to reappear; only latest persisted snapshots are supported.
8. Switch to **B**. Confirm A's threads disappear. Create B's own thread. Switch back to A and confirm B's content never appears there.
9. While A is selected, type a request naming **B** explicitly. It should block submission and ask you to select B; similarly, a question explicitly naming both should not execute as an unauthorized cross-business comparison.

## Phase 3 — authorization and lifecycle, administrator-assisted

1. Using second test user with A-only access, confirm B is absent. An HTTP GET/POST to `/api/control/chat` with `X-GetDone-Portfolio-Id: <B_ID>` must be denied (403) and not reveal text. Do not send live cookies or tokens to anyone.
2. Revoke A membership for that test user in staging. Existing session must lose access to A's history, new chat submissions and intent status; verify server-side membership check on every request.
3. Restart **staging only** web server. Saved threads, business mapping and last worker lifecycle snapshot must still be recoverable on login. Confirm no secrets, cross-tenant records or raw orchestration payloads enter the browser response.
4. Create one innocuous staging action from an explicit new request; inspect the proposal. Approve only the reviewed reversible action via the existing passkey step-up and decision UI.
5. Inspect staging worker/deploy logs and external sandbox target: exactly one side effect should occur; independently verify the actual result, audit/correlation ID, recovery behavior and updated job/objective/decision/status UI.
6. Re-send the **same idempotency key** through an administrator-controlled test harness (not an accidental UI double click) and confirm no duplicate external effect. Restart the worker once to verify durable queue recovery.
7. Switch the feature flag **off in staging** after documenting the result; verify original navigation and authorization paths still work. Restore the reviewed staging setting, without touching production.

## Pass / fail and evidence

Save the exact reviewed web/worker SHAs, CI URL, staging deploy IDs, timestamp, screenshots of thread A/B/restart and owner action, and redacted correlation/audit/independent verification references. A single missing security denial, unexpected cross-business record, false `verified` status or duplicate external action is an automatic **NO-GO**.

**Not yet claimed:** production deployment, real staging authentication, multi-tenant passkey acceptance, genuine model-based semantic interpretation, autonomous cross-business comparisons, and a complete durable per-event worker progress ledger. CI tests alone do not prove those capabilities.
