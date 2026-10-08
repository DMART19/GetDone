# GetDone production readiness — 8 October 2026

## Decision

**No: David cannot rely on GetDone for daily use tomorrow in its current deployed state.** The public health endpoint returns HTTP 502 (`x-render-routing: no-deploy`). Render builds main successfully, but startup rejects the missing governed production integration. My Workspace contains only `getdone-web`; neither dedicated worker exists there.

**Overall engineering readiness estimate: 55%. Maturity: Alpha.** This is a judgment about implemented code plus verified operation, not a measured percentage of features or a claim of uptime. The control plane is substantially implemented; production commissioning and the central conversational experience remain incomplete. Private beta requires a working owner journey and live execution evidence.

This audit examined main `0b935dbf7165c96317e12020391a5f2c42c3389a`, cloned from `DMART19/GetDone`, with a clean initial working tree. No AGENTS.md files were found in the checkout. Refinements are in draft PR https://github.com/DMART19/GetDone/pull/119. They are **not merged or deployed**. No production secrets, database contents, migrations, approval rules, or tenant policies were changed.

## Evidence and scope

Inspected package/runtime configuration, Render Blueprint and actual service/deploy logs, startup/environment validation, PostgreSQL readiness/TLS and migration tooling, auth/passkey/bootstrap implementation, GitHub credential delivery, OpenRouter routing, both worker entrypoints, durable jobs and execution admission, policy and approval services, independent verification contracts, intelligence/context and conversation persistence/routing, integration registry/adapters, CI, and release scripts. The repository contains 28 SQL migration files. Inspection was targeted around the production journey; it is not a claim of exhaustive line-by-line security review.

Live evidence:

- Render workspace: My Workspace (`tea-db23uo17lnhs73dgv31g`). Web service: `srv-db24imei0phs73d93p20`.
- Latest inspected deploy: `dep-db3dssgbr16s73e2gn0g`, `update_failed`, main SHA above. Build logs say successful; runtime logs say `INTEGRATION_CONFIG: At least one governed ordinary production integration must be configured`.
- Startup stops before database verification when static configuration fails. Therefore successful Supabase connectivity, migrations, bootstrap, and backup evidence are **not established** by those logs.
- GitHub main has `protected: false`. Main CI run 37670280216 failed at the dependency gate. PostgreSQL run 37670280165 failed because its non-TLS disposable database violates the production TLS verifier. Browser staging run 37670280194 passed, including WebAuthn acceptance. That staging result is not production owner sign-in evidence.
- `DATABASE_URL`, `RENDER_API_KEY`, `OPENROUTER_API_KEY`, and the worker token are unavailable in this execution environment. The Render connector can inspect services/logs but exposes no worker-creation operation. Existing live secret values were not read or replaced.

## Scores after the proposed refinements

Scores combine code evidence and operational proof. Unverified production behavior limits scores even where unit tests pass.

| Category | /10 | Why |
|---|---:|---|
| Architecture | 8 | Existing scoped control plane, durable orchestration, policy, execution and verification separation; no rewrite needed. Multiple deployment paths increase commissioning complexity. |
| Conversation Intelligence | 3 | Regex intent classification and hard-coded named references; read-only answers summarize recent records rather than answer the actual question. Continuation context is incomplete. |
| Execution | 6 | Durable claims, retries, admission checks and adapters exist and are tested; no live workers or verified production operation. |
| Governance | 8 | Scoped authority, grant lineage, idempotency and current-state rechecks are implemented. End-to-end production evidence absent. |
| Approval | 8 | Exact plan/step binding and fresh step-up proofs are enforced. David's real passkey/approval ceremony is unverified. |
| Policy | 8 | AUTO/APPROVAL_REQUIRED/STRONG_APPROVAL/BLOCKED, budgets, kill switches and capability checks are present. Live bootstrap/policy state unknown. |
| Verification | 7 | Independent evidence, freshness, contracts and uncertain/failed verdicts are implemented. No verified live GitHub result. |
| Authentication | 6 | Passkeys, sessions and scoped membership checks; staging browser acceptance passed on main. Actual production enrollment/login unknown. |
| Security | 6 | TLS, tenant controls, brokered credentials, redaction and headers; proposed dependency gate passes. Main is unprotected and release evidence is incomplete. |
| Database | 6 | Migrations, RLS/readiness contracts and transaction tooling exist. Real Supabase state and restore evidence unverified; revised PostgreSQL CI passed against disposable infrastructure. |
| Infrastructure | 2 | Only web service exists in the selected Render workspace; two specified workers absent. |
| Deployment | 2 | Build succeeds, but latest deploy fails and public service returns 502. No known-good rollback deployment verified. |
| Developer Experience | 7 | Numerous reproducible commands/runbooks; this PR fixes hidden test exclusions and nested dependency installation. CI remains blocked by coverage. |
| Observability | 5 | Telemetry/correlation/worker health implementations exist and startup logs are useful. Collector ingestion and production worker health unverified. |
| Reliability | 4 | Leases, draining, retries and recovery code exist; no working full production topology, recovery exercise or verified restore. |
| Testing | 6 | 1,062 runnable tests pass; 157 skipped. Coverage below required thresholds; external/database/browser acceptance incomplete. |
| Performance | 5 | Bounded pools, concurrency and queries exist; web shared JS around 103 kB. No real load/latency evidence; 512 MB web tier not validated under workload. |
| Overall Production Readiness | 5.5 | Substantial implemented foundation, blocked live system, incomplete core conversation experience. Not an arithmetic average. |

## Remaining blockers

“Automatic” describes what an engineer/agent can fix with appropriate access, not work already completed. Missing evidence is identified separately from proven failure.

| Severity | Blocker, why it matters and owner impact | Required fix | Automatic? |
|---|---|---|---|
| CRITICAL | Live web startup fails; David gets 502 and cannot use the app. | Register a real governed integration with actual provider/resource/company bindings, then satisfy startup and deploy. Do not insert dummy JSON to pass the gate. | Partly; real GitHub App installation/signing key and authoritative bindings require secure access. |
| CRITICAL | Job and orchestration workers absent in My Workspace; accepted work cannot be relied on to advance or execute unattended. | Apply the existing two worker definitions, share required configuration, verify readiness, heartbeats, claims and graceful drain. | Yes with Render worker administration; unavailable through current connector. |
| CRITICAL verification gap | Production DB readiness, owner bootstrap and actual passkey login are unverified. A connected URL alone does not prove usable identity or schema. | Inspect existing Supabase state; run readiness, apply only missing migrations, validate deterministic bootstrap and David's real passkey login. | DB work with secure access; David must perform his owner authentication ceremony. |
| HIGH | Conversation answers do not meet daily-use expectations. `groundReadOnlyAnswer` reads the latest 30 entities, filters payload text, and joins six summaries for status, explanation and recommendation alike. Revenue questions do not select revenue evidence or produce grounded causal analysis. | Finish question-aware evidence selection and bounded synthesis using existing intelligence components; explicitly expose unknowns and freshness. Add acceptance cases for David's actual questions. | Engineering work; broader than a small refinement, no new architecture required. |
| HIGH | “Do it” does not reliably resume an understood proposal. `continuesIntentId` is assigned but has no consumer; the new turn can get its own orchestration and the planning snapshot contains the new message rather than the prior proposal. Named references are hard-coded, not canonical scoped entity resolution. | Resolve canonical scoped entities and prior proposal, continue the existing governed lifecycle, clarify ambiguity, test duplicate/stale/cross-tenant continuations. | Engineering work; requires focused behavioral implementation and DB acceptance, not relaxed approvals. |
| HIGH | Full coverage gate fails; successful unit tests alone cannot authorize a release. | Add meaningful missing coverage in exercised orchestration/persistence/runtime paths and run the required gate. Keep thresholds. | Yes; substantial test work remains. |
| HIGH verification gap | No live OpenRouter primary/fallback/canary or governed GitHub read/write/independent-verification evidence. | Run existing live acceptance with actual credentials and a bounded, owner-approved repository operation; inspect persisted result and independent evidence. | Mostly with secure configuration; actual approval remains authoritative. |
| HIGH | Main is unprotected while Render auto-deploys commits. A bad or unverified merge can deploy immediately. | Protect main with required checks; prohibit force push/deletion and GitHub App bypass. | Requires GitHub administration capability not exposed by this connector. |
| HIGH verification gap | Backup/restore and rollback readiness not verified against production. Startup verifier requires fresh backup evidence. | Obtain real Supabase backup and restore validation; record genuine evidence, establish a healthy deploy rollback target and rehearse code rollback/drain. | With infrastructure access; never fabricate evidence or run destructive production restore tests. |
| MEDIUM verification gap | Telemetry exporter is configured in code but backend receipt is unverified. | Send canary and find its trace independently in the collector; verify runtime errors and worker health reach the operator. | With collector access. |
| LOW | Five high-severity development dependency entries remain in the lint dependency chain (braces, micromatch, fast-glob, Next ESLint plugin/config); enforced production/critical gate passes. The audit suggested a tooling downgrade, not a safe compatible patch. | Assess patched lint-toolchain updates as they become compatible. Not itself the current production blocker. | Yes when compatible updates exist. |
| COSMETIC | No cosmetic issue established as a daily-use release blocker. | None required for clearance. | Not applicable. |

## Implemented in PR #119

1. Explanation questions containing action verbs no longer become action requests (regression examples: explaining deployment/deletion and asking why email was sent).
2. Default Vitest suite now includes startup-hook and production-runtime validator tests that were silently omitted.
3. Integration admission tests now include objective authority and correctly hashed connected/mock fixtures, exercising their intended rejection paths.
4. Production secret validation rejects long placeholder instructions and copied generation commands without printing the value.
5. PostgreSQL production verifier bounds connection waits to 5 seconds and SQL statements to 15 seconds.
6. Build no longer runs a nested `npm install`; dependency installation belongs to the caller's locked `npm ci` step.
7. Next.js/eslint-config-next patched to 15.5.27, source-map-js lockfile updated, Vitest and coverage updated together to 4.1.11, patched sharp pinned to 0.35.5. No audit thresholds weakened.
8. PostgreSQL CI now configures a disposable TLS server with a trusted, one-day test certificate. Production certificate verification remains mandatory.
9. CI compiles the orchestration worker as well as the job worker.

## Actual verification

| Check | Result and limitation |
|---|---|
| Type checking | PASS after final build; an earlier concurrent build/typecheck collided over generated `.next/types`, then a sequential rerun passed. |
| Lint | PASS with zero warnings after fixture cleanup. |
| Full runnable tests | PASS: 181 files, 1,062 tests; 30 files / 157 tests skipped for external or database requirements. |
| Production validator tests | PASS: all 14 after final fixture cleanup. |
| Coverage | FAIL: statements 72.35%, branches 68.85%, functions 75.29%, lines 73.65%. Required: 80/75/75/80. No thresholds changed. Hosted CI run 37832564373 also fails at this coverage gate. |
| Critical-module mapping | PASS: 100%, 641 mapped test cases. This is not equivalent to runtime coverage. |
| Web build | PASS on Next 15.5.27 with explicit development-seed identity. Not a production credential/database check. |
| Both worker builds | PASS. |
| Worker startup with no secrets | Correctly FAILS CLOSED. Job worker fails production configuration validation; orchestration worker requires DATABASE_URL. Neither counted as a healthy worker. |
| Dependency security gate | PASS: production high/critical=0; full graph critical=0; five high-severity development lint-chain findings remain visible. |
| sharp native image encoding | PASS: generated a 92-byte PNG. |
| Runtime, secrets, architecture, environment manifest, contract versions, migration-policy checks | PASS locally on inspected code. |
| Deployment verifier | PASS for its checked-in Kubernetes topology. It does not inspect or certify the actual Render deployment. |
| YAML parsing / diff checks | PASS. Hosted CI also passed disposable TLS setup, migrations/concurrency, rolling migrations, readiness, tenant RLS, runtime validation, owner bootstrap, orchestration/planning/policy/authorization, rate limits, analytics and audit-tamper tests. |
| Local browser installation | BLOCKED: Chromium download failed; no local browser acceptance claimed. |
| Existing main browser/WebAuthn CI | PASS on both main and revised branch (run 37832564254), staging fixtures only. |
| Configured HTTPS and webhook staging workflows | PASS on revised branch: runs 37832564273 and 37832564279. Staging evidence, not the production GitHub integration. |
| PostgreSQL CI | Main failed at TLS mismatch. Revised run 37832564357 PASSED completely, including real staging backup/restore/app boot, disaster recovery, Control API, durable worker failures/backpressure/dead letters, crash/restart and production-auth acceptance. Disposable CI infrastructure only; real Supabase remains unverified. |
| Local built-app HTTP smoke | PASS: health, sign-in and control health respond HTTP 200 in development-seed mode. Does not validate production persistence/auth. |
| Live health | FAIL: HTTP 502. |
| Live database, auth, AI, provider, approval-to-result and collector acceptance | NOT RUN: no secure local credentials and live service unavailable. |
| Go node agent tests / Docker image builds | NOT RUN: Go and Docker executables unavailable locally. |

## Work required before regular daily use

These are engineering estimates, not commitments or a backlog of hypothetical enterprise features. Unknown production DB/configuration state can increase them. Hosted PostgreSQL and browser acceptance now pass; these estimates cover remaining production evidence and code gaps. Some work can overlap.

| Remaining work | Estimate | Complexity |
|---|---:|---|
| Secure configuration, real integration registration, DB/bootstrap inspection and two worker deployments | 4–8 engineering hours, plus owner/access turnaround | Medium |
| Question-aware answers and canonical entity/proposal continuation on the existing control plane | 12–24 hours | High |
| Remaining coverage improvements and final release checks | 6–16 hours | Medium–high |
| Live owner journey, provider/model acceptance, backup/restore/rollback and telemetry verification | 4–8 hours | Medium–high |
| Total planning range | **26–56 engineering hours** plus external waiting | Confidence: moderate-low until live DB access and hosted CI complete |

Remaining deployment work: adopt the existing web service, deploy both dedicated workers, verify all three roles and retain a known-good immutable release. Remaining configuration: real owner/tenant/passkey state, GitHub App and resource binding, approved AI profiles/canary, broker/worker secrets and collector settings. Existing values must be inspected and preserved, not regenerated wholesale.

Remaining integrations: **one genuine governed GitHub integration** is sufficient for the initial software-work journey, plus OpenRouter for the AI route and existing Supabase persistence. Gmail, Slack, eBay and additional CRMs are not prerequisites for this initial clearance.

Exit condition: David signs in with his actual passkey, asks a grounded company question, receives a scoped proposal, approves through the existing policy path, watches a real job execute and sees an independently verified result persist across restart. Until that succeeds on the deployed topology, label GetDone Alpha and do not call it production ready.

## Final hosted checks

Code commit `bcc3c48057165a287db62a3bb5ad6b7ac629413f`:

- PostgreSQL Integration: PASS — https://github.com/DMART19/GetDone/actions/runs/37832564357
- Browser Staging Acceptance / WebAuthn: PASS — https://github.com/DMART19/GetDone/actions/runs/37832564254
- Configured HTTPS Staging Acceptance: PASS — https://github.com/DMART19/GetDone/actions/runs/37832564273
- Webhook Staging Acceptance: PASS — https://github.com/DMART19/GetDone/actions/runs/37832564279
- CI: FAIL at unchanged coverage threshold — https://github.com/DMART19/GetDone/actions/runs/37832564373

The report-only commit following this SHA changes no executable code. No live deployment was attempted with unresolved production configuration.
