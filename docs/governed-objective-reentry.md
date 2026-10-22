# Governed objective re-entry (draft PR #141)

## Safety model

The existing orchestration coordinator remains the *only* authority path: objective context snapshot → AI Gateway plan proposal → deterministic validation → policy classification → Decision / approval proof → Task DAG → authorized durable Jobs → independent verification.

`GETDONE_GOVERNED_REENTRY_ENABLED` defaults to **off**. The scheduled evaluator performs no run admission until explicitly enabled in a reviewed staging environment. Do **not** enable this flag in production as part of this draft.

When enabled, `runObjectiveEvaluationPass` calls `runGuardedObjectiveReentry`, which can create only a coordination-only, `accepted` orchestration run in the existing PostgreSQL run/worker store. It cannot grant approvals, create jobs, call n8n, or mark a result verified.

Preconditions: an active owner membership (checked by the evaluator), exact portfolio/company/environment/user scope, a verified hash-bound outcome, a completed predecessor Objective run with verification checkpoints, no newer unfinished run, an eligible objective with declared success criteria, no unresolved dependencies, and fewer than **three total** runs. The outcome must postdate the predecessor's creation so an old receipt cannot create further cycles. Admission is protected by a PostgreSQL transaction and per-objective advisory lock; run IDs and idempotency keys are derived from verified outcome lineage. A restart may replay the same identity, never a new approval or grant.

## Test commands

```sh
npm ci
npm run typecheck
npm run lint
npm test -- --maxWorkers=2
npm run build
npm run build:worker
npm run build:orchestration-worker
npm run verify:architecture
npm run verify:secrets
npm run verify:dependencies
npm run test:e2e
```

Targeted tests:

```sh
npx vitest run lib/orchestration/guarded-continuation.test.ts lib/orchestration/guarded-continuation.server.test.ts lib/orchestration/governed-reasoning.test.ts lib/operations/objective-evaluation.continuation.test.ts
```

## Mandatory acceptance before enabling

- Disposable PostgreSQL: two tenants, unauthenticated/foreign user denial, restricted RLS roles, concurrent schedulers and restart/replay with persisted run/worker state.
- A verified predecessor produces *one* accepted successor; no verified outcome, terminal objective, missing approval, changed context or missing dependencies must not produce any executable work.
- Verify that the second run starts with empty grants, tasks and verification checkpoints; new planning must encounter all the existing approval, spend and capability checks.
- Retry original outcome after completion and confirm no additional accepted run; verify the cycle cap and owner inbox.
- No real writes to Render, Supabase staging or n8n until the owner's separate deployment and migration approvals, current private backup/restore evidence and passkey acceptance.

Passing mock/unit tests alone does not satisfy these live and SQL acceptance gates.
