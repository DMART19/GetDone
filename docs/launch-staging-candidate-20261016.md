# GetDone unified staging launch candidate — engineering handoff

**Status: NOT ACCEPTED / DO NOT DEPLOY AUTOMATICALLY.** This document tracks code readiness; it is not live acceptance evidence.

## Candidate chain

- Base: `staging/getdone-unified-acceptance-20261014` (PR #131), reviewed base at time of branch creation: `f3d3f7554de740992646b279639369de1efb9572`.
- Launch hardening: `launch/staging-tls-fail-closed-20261016` (PR #132). Pin its **current head SHA** at deployment time; never assume the historical base SHA is still current.
- Production branch, production Render resources, and existing production-linked background workers are **out of scope**.

## Code changes to validate

1. PostgreSQL staging rejects TLS downgrade and URL-level `sslmode=no-verify`, even without Node production mode. The configured CA remains operator-controlled and certificate verification remains enabled.
2. The staging integration workflow triggers for pull requests targeting the unified staging branch and includes execution, orchestration, operations, authorization, persistence, n8n, and package changes.
3. Signed n8n callback validation rejects non-object scope/parameters and non-empty or non-object deployment-health payloads.
4. Job and orchestration worker regression tests cover health-port bind collisions, failed startup cleanup, and database close behavior.
5. Governed branch-execution regression tests cover wrong-actor and expired approvals before any network dispatch, in addition to existing approved execution, independent receipt verification, and replay tests.

## Mandatory code validation

Run on the **exact candidate SHA** in isolated CI:

```sh
npm ci
npm run typecheck
npm run lint
npm run test -- --maxWorkers=2
npm run build
npm run build:worker
npm run build:orchestration-worker
npm run verify:architecture
npm run verify:secrets
```

Inspect the GitHub Actions job logs; a mergeable PR and committed tests do not demonstrate that they pass. Also run the targeted suites:

```sh
npx vitest run lib/persistence/postgres/tls.test.ts lib/execution/job-worker-process.server.test.ts lib/orchestration/worker-process.server.test.ts lib/operations/n8n-envelope-validator.test.ts lib/operations/n8n-acceptance.test.ts
```

**Gate:** record exact SHA, workflow URL, run ID, completed conclusion, and individual failures. No green status may be inferred from absence of runs.

## Mandatory live staging preflight (not yet passed)

- Validate staging-only `DATABASE_URL` independently against Supabase project `ddxjiszbsmmbqxuoecmg`; do not reveal credentials in CI/chat.
- Reconcile seven duplicate Render environment keys between staging web and `getdone-staging-runtime`; confirm canonical source privately.
- Provision and verify a genuine PEM CA trust anchor at the `PGSSLROOTCERT` path accessible to **each** staging worker; require verified hostname and certificate chain. Never set `NODE_TLS_REJECT_UNAUTHORIZED=0` or disable TLS.
- Obtain fresh **real** backup evidence plus independently restore a snapshot on an isolated disposable server. Never insert fabricated timestamps, run destructive restore against the staging app database, or weaken production verification.
- Prepare dedicated `getdone-job-worker-staging` and `getdone-orchestration-worker-staging` only within the owner's approved ~$14/month combined budget, with staging-only credentials, explicit roles and build/start commands, Oregon, and auto-deploy disabled. Do not edit existing suspended production-linked workers.
- Align staging web and both staging workers to one reviewed candidate SHA. The current staging web historically points to `staging/david-edition-conversation-integration`, not the unified candidate; record actual deploy IDs before acceptance.
- Owner personally enrolls a WebAuthn passkey and demonstrates authenticated login/logout/restart.
- Run the complete real `Understand → Investigate → Propose → Approve → Execute → Verify → Record` flow, denial, replay, wrong-tenant, n8n rejection, restart/recovery, and independent side-effect receipt tests. Record redacted evidence, not just fixture passes.

## Acceptance decision

**BLOCKED** until verified green CI **and** live staging prerequisites above. Static code audit and mocked workflow tests alone never establish deployment, worker readiness, tenant isolation, durable recovery or production certification. Keep PR #132 draft until gates have been reviewed.
