# Sol Orchestration Runtime Foundation

Date: 2026-09-27

## Status

Implemented foundation, intentionally unconnected to live planning/execution.

This tranche establishes the durable orchestration spine required to connect owner intent and future sensed investigations to GetDone's existing planning, policy, approval, Task, Job, verification, and audit authority systems.

It does **not** claim that OpenRouter planning, SignalBus-triggered orchestration, or Decision approval continuation is live.

## Implemented

### Durable authority object

`OrchestrationRun` is now the mutable workflow authority for cross-system progress.

`OwnerIntentRecord`, signals, investigations, plans, decisions, Tasks, Jobs, verification receipts, and outcomes remain their own authoritative evidence/domain records.

The run carries:

- one correlation ID
- portfolio/company/environment scope
- initiating authority identity
- immutable source reference
- strict lifecycle state
- optimistic version
- worker lease metadata
- retry/defer timing
- bounded error metadata

### Strict lifecycle

The coordinator enforces explicit transitions across:

`received -> context-building -> planning -> validating -> policy-evaluation -> awaiting-approval/authorized -> materializing -> queued -> executing -> verifying -> succeeded`

with explicit `blocked`, `failed`, `cancelled`, and `replan-required` branches.

A coordinator cycle performs one bounded durable transition only.

### OwnerIntent atomic trigger

The PostgreSQL OwnerIntent transaction now atomically persists:

1. the accepted OwnerIntent
2. its deterministic OrchestrationRun
3. an `orchestration.triggered` routing event
4. `owner-intent.accepted` audit lineage
5. `orchestration.created` audit lineage
6. the existing idempotency completion

A committed OwnerIntent therefore cannot be newly accepted without also creating its orchestration trigger.

Existing historical intents are deliberately **not** backfilled into runnable orchestration, because replaying old owner requests later could create unexpected side effects.

### Routing outbox

`orchestration_outbox` is an internal cross-tenant routing queue.

It contains routing metadata only. It must not contain:

- owner messages
- plan content
- model prompts/responses
- credentials or secrets
- provider request/response payloads

The production database verifier enforces the exact allowed column set. Any future schema expansion fails verification until explicitly reviewed.

The authoritative `orchestration_runs` table remains tenant-RLS protected.

### Lease-safe worker coordination

The PostgreSQL store supports:

- `FOR UPDATE SKIP LOCKED` routing claims
- worker claim expiry
- tenant-scope re-entry before reading a run
- authoritative run lease
- optimistic run version checks
- claim-owner checks before queue mutation
- lease-aware queue deferral
- crash-safe redelivery
- idempotent deterministic resume event IDs

A worker cannot clear another worker's newer routing claim.

A run already leased by another worker moves its routing event to the authoritative lease expiry instead of hot-looping.

### Worker boundary

`PersistentOrchestrationWorkerService` exists as an injectable server runtime.

It requires:

- `GETDONE_PROCESS_ROLE=orchestration-worker`
- `GETDONE_ORCHESTRATION_WORKER_ID`

No executable production worker entrypoint is installed yet because the real context/planning/policy stage handler is not connected. This is intentional fail-closed behavior.

### Release and production truth

Database migration:

`2026-09-27.1_orchestration_runtime.sql`

Database schema release truth:

`2.3.0`

Release registry schema:

`1.7.0`

Generated release manifest schema:

`1.7.0`

The migration is classified as a zero-downtime `expand` migration.

PostgreSQL readiness and production verification now require the orchestration relations/indexes and RLS protection.

The generated machine release manifest records orchestration as:

- runtime: `implemented-unconnected`
- OwnerIntent trigger: `implemented`
- Signal trigger: `not-connected`
- planning handler: `not-connected`
- Decision continuation: `not-connected`

## Authority invariants preserved

- OwnerIntent cannot directly execute provider work.
- The routing outbox is not execution authority.
- Orchestration state does not authorize a Task or Job.
- AI/model output remains a proposal.
- Existing policy/approval/authorization services remain required for executable authority.
- Job runtime still requires persisted authoritative Job + Task authorization lineage.
- Provider success remains evidence only.
- Verification remains required for authoritative success.
- Correlation ID remains the end-to-end reconstruction key.

## Architecture dependency rule

A one-way dependency rule now prevents UI, Control API, AI Gateway, authorization, domain services, execution, integrations, intelligence, planning, resources, verification, and voice modules from importing the orchestration authority layer.

The intended direction is:

`orchestration -> existing authority primitives`

not:

`authority primitive -> orchestration`

The persistence adapter is the deliberate ingress bridge for accepted OwnerIntent records.

## Acceptance coverage

Fast unit coverage now exercises:

- orchestration transition rules
- immediate vs external wake behavior
- defer behavior
- invalid-transition fail-closed behavior
- deterministic OwnerIntent run creation
- routing-only trigger persistence
- idempotency-envelope conflicts
- worker/run claim leasing
- busy-run lease deferral
- terminal-event cleanup
- transition + resume + audit behavior
- defer ownership checks
- worker configuration and drain behavior

PostgreSQL integration coverage additionally exercises:

- OwnerIntent -> run -> outbox atomic persistence
- duplicate idempotent OwnerIntent delivery
- RLS-scoped run access after global routing
- durable state advancement
- external wake barriers
- correlation audit reconstruction
- lease-aware routing deferral

## Intentionally deferred to the next tranche

1. Authoritative context snapshot builder.
2. Governed planning handler using the existing AI Gateway/OpenRouter boundary.
3. Plan validation + policy step evaluation inside the coordinator.
4. Decision/Approval binding and exact-hash continuation.
5. AuthorizationGrant issuance and Task materialization.
6. Job materialization/enqueue handoff.
7. Verification/outcome reconciliation.
8. SignalBus/Sensing/Investigation trigger bridge.
9. Live orchestration worker heartbeat/health reporting.

These should reuse this runtime rather than create a second OwnerIntent or signal execution path.
