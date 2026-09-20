# Astra Handoff — Updated After Sol Foundation Pass

This repository has already been advanced beyond a visual scaffold. Astra should inspect the current code and completion reports before editing and should **not** rebuild deterministic work that already exists.

## What is already present

### Owner surface

- Home / Chat
- Decisions + Decision Detail
- Resources
- Add Resource
- Resource Detail
- Sign-in shell
- loading / error / not-found / offline presentation
- screenshot-focused iPhone styling
- permanent bottom navigation exactly Chat | Decisions | Resources

### Control/authority foundation

- provider-neutral Control API contracts
- typed API envelopes and errors
- correlation and idempotency helpers
- development read-repository boundary
- authentication/session/step-up interfaces
- tenant-scope/tampering guards
- typed capability registry
- objectives + guardrails domain
- deterministic state machines
- audit contract
- idempotency foundation
- kill switches
- side-effect admission checks

### Intelligence substrate

- transactional Signal Bus contracts
- trusted source-binding scope resolution
- durable dedupe/cursor interfaces and out-of-order event handling
- company/resource deterministic sensing profiles
- freshness/cooldowns and Investigation coordination
- advisory external-research quotas and failure isolation
- bounded fresh scope-aware context sections with explicit resource authorization

### Planning / authorization / compilation substrate

- GetDone-owned structured plan schema
- server-authorized plan scope/source construction boundary
- deterministic plan validator
- AUTO / APPROVAL_REQUIRED / STRONG_APPROVAL / BLOCKED policy engine
- budget / guardrail / kill-switch / step-up preflight
- immutable task generation with authorization lineage
- semantic logical task deduplication
- deterministic executable DAG compiler
- typed capability mapping and input revalidation
- preconditions, verification nodes, rollback/cancellation semantics
- future resource requirement envelopes with resource selection explicitly deferred

### Verification, outcomes, and operational memory

- first-class Verification state machine
- hash-bound VerificationRequest / VerificationEvidence / VerificationReceipt contracts
- freshness, expiry, target/scope binding, and evidence-integrity checks
- independent-source requirements and explicit uncertain results
- Job and Outcome completion paths bound to verification receipts
- advisory Fact / Lesson / Experiment / Observation / OutcomeReference memory records
- confidence, sample size, confounders, evidence, expiry, supersession, and relevance ranking
- strict company isolation and bounded memory context integration
- memory cannot promote itself into policy authority

### Resource Registry and enrollment foundation

- expanded authoritative Resource vocabulary and lifecycle
- identity/trust evidence, health records, capability bindings, locations, cost profiles, and provider bindings
- tenant-scoped Resource Registry read models
- fail-closed READY gate for identity, trust, health, capability, policy, environment, and adapter evidence
- deterministic enrollment state machine from IDENTIFY through READY
- hashed one-time token/challenge storage, expiry, replay resistance, cancellation/failure/expiry, and restart semantics
- no real Pi/Linux agent or scheduler is represented as implemented

### Verification

CI runs install, secret-pattern scan, typecheck, lint, tests, and build. Do not bypass those gates.

## Owner-action blockers before canonical Phase 2/3 PASS

1. Select/provision the real authentication/session implementation.
2. Select/provision the authoritative database.
3. Add real migrations and RLS/authorization rules.
4. Run real session revocation, tenant isolation, and cross-company leakage tests.

Do not invent a provider and do not mark these phases PASS until those acceptance checks are real.

## Work reserved for Astra

Once the owner/infrastructure blockers are resolved, Astra should focus its higher-compute budget on the work that benefits from it:

1. **Phase 13 — production AI Gateway**
   - OpenRouter server-side adapter
   - model-role routing
   - capability/data/environment eligibility
   - canaries
   - safe fallback
   - budgets/concurrency/rate limits
   - model/provider kill switches
   - response schema validation and audit

2. **Provider-connected completion of Phases 14–17**
   - route model-originated proposals through the production AI Gateway and the existing GetDone-owned plan schema
   - bind policy/approval state to the real auth/session/database implementation
   - persist task-deduplication and authorization lineage atomically
   - preserve the existing validator, policy engine, task generator, and DAG compiler rather than replacing them

3. **Phases 19–21 — durable execution and software delivery**
   - persistent queues
   - claims/leases/heartbeats
   - retries/dead-letter/cancellation/recovery
   - business adapters
   - software-worker/deployment pipeline

4. **Provider-connected completion of Phases 22–23**
   - persist verification requests/evidence/receipts atomically
   - connect real system/business measurement collectors
   - persist operational memory and retrieval indexes
   - preserve the existing verification and advisory-memory authority boundaries

5. **Provider-connected completion of Phases 26–31 — Resource Fabric**
   - persist the existing registry/enrollment contracts
   - Raspberry Pi/Linux agent
   - real cryptographic resource identity evidence
   - credential broker
   - profiling/authenticated telemetry
   - resource/data policy
   - do not replace the existing READY or enrollment authority gates

6. **Phases 32–40 — placement/resilience/economics**
   - candidate evaluation
   - reservations/capacity ledger
   - scheduler/dispatch/start verification
   - cost governor
   - storage fabric
   - failure domains and failover
   - adapter SDK + second provider
   - partner/DC pools
   - zero-side-effect simulator

7. **Phases 41–44 — release and final gate**
   - version/release evidence
   - operating manuals
   - voice handoff
   - optional Watch
   - adversarial/end-to-end production acceptance

## Non-negotiable constraints

- AI thinks; GetDone authorizes.
- Frontend is a control surface, not execution authority.
- Models/providers/resources never set approval, job, placement, trust, or verification truth.
- OpenRouter/model SDK code stays behind the GetDone AI Gateway.
- Raw production secrets stay out of browser storage, client bundles, normal logs, prompts, resource metadata, and docs.
- Every consequential side effect remains scoped, typed, policy-checked, authorized, idempotent, auditable, failure-aware, and independently verified.
- Keep the owner experience screenshot-simple as backend complexity grows.

## Start condition for Astra

Before a heavy Astra pass, read:

- `docs/GetDone_UFO_v2_MASTER_BUILD_PLAN.md`
- `docs/SOL_UPGRADE_EXECUTION_PLAN.md`
- `docs/SOL_IMPLEMENTATION_STATUS.md`
- `docs/PHASE_2_REPORT.md`
- `docs/PHASE_3_REPORT.md`
- `docs/SOL_PHASE_22_23_26_27_REPORT.md`
- latest GitHub Actions result

Then continue from the first unblocked canonical phase without silently replacing the authority model.
