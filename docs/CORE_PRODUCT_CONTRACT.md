# GetDone Core Product Contract

## Product identity

GetDone is an **AI execution control plane**.

The core product loop is:

`OBJECTIVE → PLAN → AUTHORIZE → EXECUTE → VERIFY → COMPLETE`

The control plane owns coordination and authority. AI proposes and plans; policy, owner authority, durable execution, verification, and audit establish what is allowed and what is true.

## Owner operating model

The owner primarily manages:

- goals and objectives;
- material decisions;
- exceptions;
- outcomes;
- operating policy.

The owner should **not normally manage individual implementation steps**. Implementation steps belong to GetDone's governed planner, Task DAG, Job runtime, connected capabilities, and verification system.

## Core-complete acceptance contract

GetDone is core complete only when a user can:

1. Enter one or more objectives.
2. Leave the application.
3. Have GetDone independently plan and execute authorized work.
4. Be interrupted only when owner authority is required.
5. Approve, modify, or reject those decisions.
6. Have execution automatically resume afterward.
7. Receive a verified outcome rather than merely a provider success response.
8. Run this process across isolated companies using connected capabilities.
9. Convert repeated owner decisions into explicit reusable policies **only after owner confirmation**.

All nine conditions are required. Partial implementation must not be labeled core complete.

## Authority invariants

1. **Objective/intent is the source of work.** The control plane must preserve source and correlation lineage.
2. **Planning is not authority.** A Plan is a proposal until validation and policy/owner authorization succeed.
3. **Authorization is exact.** Grants bind tenant scope, Plan hash, step hash, validation receipt, policy snapshot, capabilities, approval proof when required, and expiry.
4. **Authorization is consumed once.** Task creation and authorization consumption are durably and atomically bound.
5. **Execution is durable.** Authorized Tasks materialize a DAG; Jobs use durable idempotent queueing, leases, recovery, and bounded retry.
6. **Dependencies are authoritative.** A dependent Job cannot become runnable until predecessor Jobs are authoritatively succeeded.
7. **Providers do not own truth.** Provider accepted/completed responses cannot directly make a Job, Task, Outcome, or orchestration run successful.
8. **Verification owns completion.** COMPLETE requires authoritative verification evidence/receipts and verified outcome checkpoints.
9. **Company isolation is mandatory.** Scope is resolved server-side and all authoritative persistence/execution remains portfolio/company isolated and fail-closed.
10. **Owner attention is compressed.** Decisions are created only when policy requires owner authority; resolution must resume the same exact-hash orchestration lineage.
11. **Policy learning is owner-confirmed.** Repeated owner decisions may generate policy suggestions, but no repeated behavior becomes reusable operating authority without explicit owner confirmation.
12. **No hidden authority in AI or adapters.** Planner/model output and provider/adaptor output remain proposals/evidence, never authority.

## Orchestration semantics

The durable run states implement the product loop with finer-grained control-plane checkpoints:

`accepted → context-ready → planning → planned → validated → policy-evaluated → awaiting-decision? → authorized → tasks-created → jobs-enqueued → executing → verifying → completed`

`awaiting-decision` is entered only when owner authority is required.

For a multi-step/multi-operation Plan, `jobs-enqueued` means:

- the complete Job DAG has been durably materialized;
- every currently runnable root Job has been admitted to the durable Job runtime;
- dependency-blocked Jobs remain durably materialized and are released only after their predecessor Jobs are authoritatively verified as succeeded.

This definition preserves dependency truth rather than prematurely queueing blocked work.

## Completion rule

The following is explicitly invalid:

`provider says success → COMPLETE`

The required authority path is:

`provider observation → verification evidence → authoritative verification receipt → verified Job/Task/Outcome → COMPLETE`

## Current implementation boundary

The repository contains durable contracts/primitives for ingress, planning, validation, policy, owner decisions, exact-hash authorization, Tasks, Jobs, durable worker execution, and verification.

This contract intentionally does **not** declare GetDone core complete until the production coordinator closes the full loop from objective/Signal through execution and verified outcome, including autonomous downstream DAG release and owner-confirmed policy promotion.
