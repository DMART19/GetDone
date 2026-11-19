# GetDone Owner Edition v1 release candidate

Status: **NOT DEPLOYED / LIVE ACCEPTANCE BLOCKED**. Inspection date: 2026-11-18 (Pacific).

## Candidate and consolidation

Repository: DMART19/GetDone. Release branch: `release/owner-edition-v1-20261118`.
Baseline: PR #141, `33c9700a434a52a75d82997bc4ff960375a16c6e`.
Merged PR #143 head `b2dfab32ff640ff08da25768b57239d36c65fc87` into that baseline.
PR #138 is already an ancestor of #141; do not merge it twice. The selected branch already includes the later David Edition presentation and conversation integration. PR #127 is an earlier native UI attempt, not a standalone requirement to merge separately. Other open PRs were not merged indiscriminately.

Integration required converting three additional Zod record schemas to explicit string keys. The combined branch retains the scoped control plane, durable queues, auth/worker role boundaries and guarded operational intelligence. Seven-day sessions from #143 retain the existing five-minute step-up policy. The existing cinematic interface uses a decorative Canvas 2D background and CSS planet spheres, with accessible business buttons; it is not a literal standalone Three.js port.

Release-specific fixes: logout control calls the existing server revocation endpoint; business refreshes serialize initial/background reads and clear records on 401/403 while retaining explicitly stale snapshots for transient failures; paused/reduced-motion canvases redraw after resizing; staging topology selects David Edition and seven-day secure-cookie sessions; release verification compares migration identity with the runtime requirement instead of an obsolete fixed version.

## Observed infrastructure (read-only)

| Resource | Observed state | Last deployed commit |
| --- | --- | --- |
| getdone-web | Billing-suspended | Inspect deployment again before promotion |
| getdone-web-staging | Billing-suspended; still uses staging/david-edition-conversation-integration | 6059b304c1fdbf69ecadd56267f58c87ea6e9926 |
| getdone-job-worker | Billing + stuck_crashlooping suspension | c991acaa39f39bc9759c5d111daf51d7c321605a |
| getdone-orchestration-worker | Billing + stuck_crashlooping suspension | c991acaa39f39bc9759c5d111daf51d7c321605a |

Worker events show exit code 1 in October; retained log queries returned no logs, so the historical root cause has not been established. A past deployment status of `live` is not current worker health.

Production Supabase `ioatylrkcktsdifesomq`: ACTIVE_HEALTHY, PostgreSQL 17.11, schema `2026-10-10.1`, one non-revoked passkey credential, no worker activity within five minutes. Last recorded verified backup: October 13; the underlying backup and restore were not independently revalidated in this session. Public schema: 86 tables, 40 with RLS, zero tables with effective SELECT/INSERT/UPDATE/DELETE for either anon or authenticated. This is a table privilege observation, not blanket certification of all functions, roles or API paths.

Staging Supabase `ddxjiszbsmmbqxuoecmg`: INACTIVE. No staging SQL or migrations attempted. No production writes, service reactivation, new paid resources or credential changes were performed.

## Validation commands

Use Node 24 and the committed npm lockfile:

```sh
npm ci --include=dev
npm run typecheck
npm run lint
npm test -- --maxWorkers=2
npm run build:worker
npm run build:orchestration-worker
NEXT_PUBLIC_APP_ENV=development GETDONE_RUNTIME_ENV=development GETDONE_DATA_MODE=development-seed GETDONE_DAVID_EDITION=true npm run build
npm run verify:runtime
npm run verify:secrets
npm run verify:architecture
npm run environment:check
npm run verify:zero-downtime-migrations
npm run verify:deployment
npm run verify:contract-versions
npm run release:generate
npm run verify:release
npm run verify:dependencies
npm run test:e2e
```

`test:e2e` runs both legacy and David Edition suites. `test:e2e:owner` selects the latter. API-route UI fixtures are not live provider evidence. A supported locally installed Chromium can be selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; otherwise Playwright uses its pinned browser.

The release branch triggers the existing staging integration and isolated backup/restore workflows. Main-target PR checks additionally cover the broader CI, security, PostgreSQL and virtual WebAuthn suites. Do not substitute tests with a virtual authenticator for actual owner enrollment on an iPhone.

## Deployment gates and exact configuration

1. Owner resolves Render billing and authorizes the intended staging topology and current cost. The historical $14 worker ceiling in the topology is not renewed authorization or a verified current price.
2. Owner restores the inactive staging database. Verify its actual schema, identities and TLS configuration after restoration; do not assume it matches production.
3. Follow `docs/parallel-staging-launch-setup-20261017.md` and the pre-migration recovery branch documented in PR #138 to dump the real old-schema staging source into private storage and restore it independently. Existing-source restore verification must use the matching old-schema verifier; a newer-schema verifier cannot prove an old snapshot bootable. Obtain migration approval only after this succeeds.
4. Review and apply the existing staging auth/worker migrations through `2026-10-17.2`. No new migration is introduced by this release work. Run `node scripts/verify-staging-runtime-config.mjs --connect --workers` in the private staging environment.
5. Select an exact reviewed commit from this release branch, with passing checks on that commit. Record `git rev-parse HEAD`, the lockfile SHA-256 and migration `2026-10-17.2` in the deployment evidence. Deploy the same SHA to all three services; keep auto-deploy off. Do not apply production root `render.yaml` to staging.

| Role | Build | Start |
| --- | --- | --- |
| web | npm ci --include=dev && npm run build | npm run start |
| job-worker | npm ci --include=dev && npm run build:worker | npm run start:worker |
| orchestration-worker | npm ci --include=dev && npm run build:orchestration-worker | npm run start:orchestration-worker |

The staging topology is `config/staging-pilot-topology.json`: authoritative staging data, verified database TLS and private CA, scoped DB role, unique worker IDs and service roles. Set web `GETDONE_DAVID_EDITION=true`, `GETDONE_SESSION_TTL_SECONDS=604800`, `GETDONE_AUTH_COOKIE_SECURE=true`, RP ID `getdone-web-staging.onrender.com`, and exact origin `https://getdone-web-staging.onrender.com`. Set `NEXT_PUBLIC_APP_ENV=staging` at build time. Never copy a production origin into staging.

Keep credentials in the private runtime: staging DB URL, internal worker token, configured GitHub App credentials and resource bindings, OpenRouter model profiles/routing/budget, and n8n signing/configuration. Configure only verified capabilities. `GETDONE_N8N_ENABLED=false` remains until its signed, scoped workflow is commissioned. Do not present configured records as proof that a provider is healthy.

6. Verify web readiness, both worker heartbeats/leases, fresh post-migration backup and independent restore. Owner completes or validates enrollment on their own device. Test persistent navigation, logout/revocation and sensitive-action step-up on desktop and iPhone Safari.
7. On an explicitly approved test target: request a uniquely named branch, review the plan and policy, approve through GetDone, let the worker execute, independently read the GitHub ref, and retain execution/verification records. Test denial, replay and worker recovery. A branch created by a maintenance tool is not evidence that GetDone executed it.

No working GetDone URL is certified until these live checks succeed. The known staging address is a deployment target, not a currently accepted application.
