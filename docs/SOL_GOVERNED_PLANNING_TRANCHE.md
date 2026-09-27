# Sol Governed Planning Tranche

Date: 2026-09-27

## Scope

This tranche connects the durable orchestration runtime to GetDone's existing context, AI Gateway, plan validation, and policy primitives:

`OwnerIntent -> Context Snapshot -> Governed Plan Proposal -> Plan Validation -> Policy`

It deliberately stops before approval continuation, AuthorizationGrant issuance, Task/Job materialization, or provider execution.

## Implemented flow

### 1. Authoritative context snapshot

`OrchestrationContextBuilder` reuses `assembleContext`.

For the currently connected OwnerIntent source:

- the intent is re-read from tenant-scoped PostgreSQL
- user, environment, correlation ID, portfolio, and company must match the OrchestrationRun
- freshness and sensitivity filtering use the existing context assembler
- cross-company context is rejected
- empty/stale authorized context defers instead of inventing evidence
- the resulting context is persisted as an immutable hash-bound artifact

The persisted context snapshot records its derived data classification. The planner may not downgrade it.

Other source types such as investigations/objectives remain unconnected and return a safe unavailable result.

### 2. Governed planner

`AIGatewayGovernedPlanner` reuses the existing `AIGateway` and `PlanProposalSchema`.

Before a model can be invoked, an injected authoritative admission provider must supply:

- a valid AI budget snapshot
- current AI kill switches

The model request is structured-output only and explicitly states that AI may propose work but may not approve, authorize, enqueue, execute, or claim success.

Server-owned fields are re-bound after model output:

- portfolio
- company
- environment
- source identity
- context data class

The planner additionally rejects:

- environment escalation
- data-class downgrade
- evidence IDs not present in the persisted context snapshot
- step evidence references not declared by the plan

The resulting plan artifact preserves:

- plan hash
- context hash
- AI audit hash
- routing-decision hash
- `authorityApplied: false`

Live OpenRouter credentials/routing remain unconfigured by release truth.

### 3. Deterministic validation

The orchestration handler reuses `attestPlanValidation` and the existing `PlanValidationPolicy`.

Validation constraints are provided by an authoritative policy provider, not by the model.

The validation artifact persists:

- plan hash
- validation status
- ordered step IDs
- errors / owner-decision requirements
- validation-policy hash
- attestation hash
- `authorityApplied: false`

Invalid plans transition to `replan-required` and wait for an external continuation before spending model budget on another proposal.

### 4. Per-step policy evaluation

For each validator-ordered step, the handler reuses:

- `planStepHashes`
- `createPolicySnapshot`
- `evaluateStepPolicy`
- `strongestDisposition`

Dynamic policy evidence is injected from authoritative server providers. It may include:

- region/integration/resource/provider identity
- kill switches
- budget policy + reservation
- guardrails
- credential requirements + availability snapshot
- protected-capacity snapshot
- fallback availability

Missing required evidence defers. It is never synthesized.

The handler re-hashes the current validation policy before policy evaluation. If it changed since validation, the run moves to `replan-required`.

### 5. Authority outcome

Policy outcomes map to orchestration state as follows:

- `BLOCKED -> blocked`
- `APPROVAL_REQUIRED / STRONG_APPROVAL -> awaiting-approval`
- `AUTO -> policy-cleared`

`policy-cleared` is intentionally **not** `authorized`.

The transition graph prohibits:

`policy-evaluation -> authorized`

and permits:

`policy-cleared -> authorized`

only for a later tranche that persists and validates the required AuthorizationGrant lineage.

## Persistence

Migration:

`2026-09-27.2_orchestration_planning.sql`

Database schema release truth:

`2.4.0`

The migration:

- widens the orchestration state CHECK to include `policy-cleared`
- creates append-only `orchestration_planning_artifacts`
- enables and forces tenant RLS
- grants tenant runtime only `SELECT, INSERT`
- revokes `UPDATE, DELETE`
- indexes run/kind, tenant scope, and correlation lineage

Production verification confirms the runtime role cannot update/delete planning artifacts.

The zero-downtime verifier now permits an explicitly declared compatible CHECK widening only when the migration proves drop/re-add with `NOT VALID` and `VALIDATE`. Other destructive constraint changes remain blocked.

## Preserved authority invariants

- AI output is never authorization.
- Context/model output cannot change trusted tenant or environment scope.
- Model output cannot lower the context data classification.
- A plan cannot cite evidence outside its persisted context snapshot.
- Validation constraints come from GetDone, not AI.
- Policy inputs are persisted in versioned/hash-bound snapshots.
- Missing credential/capacity/budget evidence defers instead of being assumed.
- AUTO policy does not issue an AuthorizationGrant.
- No Task or Job is created by this tranche.
- No provider adapter is invoked by this tranche.
- No provider response can mutate authoritative orchestration success.
- Audit/correlation lineage remains reconstructable.

## Acceptance coverage

Unit coverage exercises:

- context scope/freshness/sensitivity
- model evidence grounding and data-class binding
- environment spoof rejection
- AI admission unavailable without invocation
- valid plan -> policy-cleared without authorization
- invalid plan -> replan-required
- approval capability -> awaiting-approval
- kill switch -> blocked
- missing protected-capacity evidence -> defer
- planning artifact append-only/idempotent behavior
- OwnerIntent authority-envelope checks
- transition graph prohibition on direct policy -> authorized

PostgreSQL acceptance exercises:

- authoritative OwnerIntent context loading
- immutable planning artifact persistence
- idempotent replay
- tenant RLS isolation

## Still intentionally unconnected

- live AI model routing / API credentials
- authoritative AI budget provider implementation for orchestration
- dynamic production policy-evidence provider wiring
- SignalBus / sensing / investigation ingress
- Decision creation and exact-hash approval continuation
- AuthorizationGrant issuance
- Task DAG materialization
- Job creation/enqueue
- verification/outcome reconciliation
- live orchestration worker deployment/heartbeat

Those next stages should extend this exact orchestration run and artifact chain rather than create a parallel execution path.
