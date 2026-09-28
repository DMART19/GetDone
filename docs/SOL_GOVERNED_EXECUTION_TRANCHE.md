# Sol Governed Authorization and Materialization Tranche

Date: 2026-09-27

## Scope

This tranche extends the same durable orchestration run:

`Decision/Approval -> exact-hash AuthorizationGrant -> Task DAG -> Job materialization -> dependency-ready durable enqueue`

It stops before provider execution.

## Decision and Approval authority

Approval-required policy steps materialize one deterministic Decision and one paired Approval record from:

- OrchestrationRun ID
- exact plan hash
- exact step hash
- exact PolicySnapshot ID/hash
- required approval level

Owner Decision resolution updates the paired Approval in the same serializable transaction.

For approve:

- the Approval transitions `pending -> granted`
- an ApprovalProof is created for the exact plan + step hashes
- strong approval requires and persists the fresh StepUpProof
- the Decision records the proof ID/hash

For reject/modify:

- the paired Approval is denied atomically
- no authorization grant may be issued

A Decision status by itself is not executable authority.

## Fresh authorization gate

Before issuing AuthorizationGrant records, GetDone re-reads:

- governed plan
- validator attestation
- original policy bundle
- current validation constraints
- current kill switches
- current credential evidence
- current protected-capacity evidence
- current budget/guardrail evidence
- exact ApprovalProof / StepUpProof when required

The fresh policy disposition must match the originally reviewed disposition. A changed or blocked policy result cannot reuse the old approval.

A fresh PlanValidationReceipt is built from current validation evidence. Grant TTL cannot outlive the validation receipt, approval/step-up proof, credential snapshot, protected-capacity snapshot, or configured grant TTL.

The immutable authorization bundle is persisted before grant insertion. It is the crash-recovery checkpoint: retries rehydrate the exact grants instead of minting new authority.

## Task DAG

TaskGenerator remains the Task-generation authority.

The PostgreSQL dedupe store atomically:

1. claims the logical Task key
2. verifies the exact persisted AuthorizationGrant
3. persists the grant consumption
4. persists the generated Task claim

TaskService then creates and authorizes the authoritative Task record with that exact consumption.

DagCompiler compiles the complete generated Task set. No Job exists before this governed Task authority chain completes.

## Job materialization and enqueue

One authoritative Job is materialized per generated Task.

Dependency Job IDs mirror Task dependencies.

Existing TaskService/JobService invariants remain unchanged:

- a dependent Task cannot queue until dependency Tasks are authoritatively succeeded
- a dependent Job cannot queue until dependency Jobs are authoritatively succeeded
- Job queue authority inherits the persisted Task AuthorizationConsumption

Therefore this tranche:

- materializes the complete Job graph
- queues dependency-free root Tasks
- queues dependency-free root Jobs
- writes their stable JobQueueEnvelope records to the durable Job Store
- leaves downstream Jobs in `created`
- leaves downstream Tasks in `authorized`

A later scheduler continuation may enqueue downstream work only after predecessor success.

## Provider boundary

This tranche creates **no JobExecutionSpec**.

The job-batch artifact permanently records:

`providerExecutionSpecsCreated: false`

The orchestration state may reach `queued`, but the governed execution stage handler deliberately defers there. It never calls a provider adapter, software worker, resource dispatch, or verification bridge.

Provider execution remains a separate future tranche.

## Persistence

Migration:

`2026-09-27.3_orchestration_authorization_materialization.sql`

Database schema release truth:

`2.5.0`

New append-only tenant-RLS relations:

- `orchestration_execution_artifacts`
- `orchestration_task_generation_claims`

Tenant runtime permissions are SELECT/INSERT only. UPDATE/DELETE are revoked and production verification checks those privileges.

Execution artifacts cover:

- validation receipt
- authorization bundle
- Task DAG
- Job batch

## Recovery behavior

- Decision/Approval materialization is deterministic and replay-safe.
- Approval + Decision mutation is atomic.
- Authorization bundle is the grant-recovery checkpoint.
- Task logical-key claim and grant consumption are atomic.
- Job IDs and queue envelopes are deterministic.
- A crash after Job authority is queued but before durable enqueue is recoverable: retry enqueues the same stable envelope.
- Approval waiting uses periodic durable orchestration retry, so a missed immediate wake cannot strand the run.

## Release truth

Implemented:

- exact-hash Approval authority
- Decision continuation with polling recovery
- AuthorizationGrant issuance
- Task DAG materialization
- Job graph materialization
- dependency-ready root durable enqueue

Implemented but not live-connected:

- orchestration worker/runtime deployment
- root durable enqueue in a live environment

Not connected:

- provider execution
- JobExecutionSpec creation by orchestration
- provider verification/outcome reconciliation
- downstream enqueue before predecessor success
- SignalBus ingress
- live AI/provider credentials

## Core invariant

The authority path is now:

`owner approval/policy -> proof -> grant -> grant consumption -> Task -> Job -> durable queue`

not:

`AI/Decision/UI/provider response -> Job`

No stage may skip the persisted exact-hash authority lineage.
