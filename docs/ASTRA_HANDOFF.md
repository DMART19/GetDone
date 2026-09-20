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

### Verification / operational truth

- hash-bound VerificationRequest / VerificationEvidence / VerificationReceipt contracts
- freshness, expiry, independent-verifier, failed, and uncertain semantics
- authoritative Verification state transitions
- Task / Job / Outcome truth transitions consume verification receipts rather than arbitrary evidence IDs

### Operational memory

- advisory-only Fact / Lesson / Experiment / Observation / OutcomeReference records
- confidence, sample size, confounders, expiry, supersession, and relevance selection
- strict company isolation
- bounded Context Assembler integration
- memory has no direct policy or authorization authority

### Resource registry and enrollment

- authoritative Resource Registry evidence vocabulary and lifecycle service
- identity / trust / health / capability / location / cost / provider binding records
- deterministic READY evidence gate and concise owner read model
- generic enrollment lifecycle:
  IDENTIFY -> CREATE_ENROLLMENT -> OWNER_ACTION -> AUTHENTICATE -> DISCOVER -> PROFILE -> VALIDATE -> TEST -> REGISTER -> READY
- hashed one-time enrollment challenges, expiry, replay resistance, restart/cancel behavior, scope preservation, evidence, and audit

### Portfolio intelligence and security hardening

- company-attributed portfolio summaries scoped to explicitly authorized companies
- automated adversarial regression coverage for auth, tenancy, callbacks, credentials, context isolation, external authority forgery, provider kill switches, and production promotion
- external model/provider/frontend/resource-agent authority claims fail closed
- untrusted nested authority fields are rejected
- future Resource Fabric spoof/replay/scheduler-bypass claim placeholders are evidence-only and never authoritative

### PWA / iPhone delivery foundation

- standalone manifest and iPhone web-app metadata
- service worker caches only the offline shell/icon, never API/auth state
- network-first navigation with explicit offline fallback
- service-worker update and reconnection events without granting client authority
- redacted push presentation and safe notification-click deep links
- typed Decision / Task Result / Resource / Resource Incident / Resource Decision deep links
- deterministic FYI/Normal/High/Critical notification policy
- deterministic update deferral during offline/editing/strong-approval states
- WebAuthn origin/RP/user-verification ceremony checks
- real push provider and cryptographic WebAuthn verification remain integration work

### Resource Fabric credential, profiling, policy, and placement foundation

- reference-only secret records and scoped credential bindings
- minimum-scope, hash-bound credential leases with expiry/revocation/release and audit contracts
- deterministic denial for cross-company, cross-environment, wrong-location, non-READY, or over-broad credential requests
- normalized resource profiles and independent validation for privileged capability claims
- authenticated telemetry health summarization plus zero-side-effect CI simulator scenarios
- hard resource/data placement policy for data classes, HOME defaults, region, reliability, encryption, fallback, interruption, and workload rules
- control-plane-only placement requests with active idempotency reuse
- candidate eligibility filters in scope -> policy -> health -> capability -> capacity -> credential/environment -> cost order
- pinned resources never bypass hard constraints
- candidate reports are explainable and snapshot-bound
- no scheduler ranking or dispatch has been added

### Phase 33 reservation and capacity-ledger foundation

- resource/pool ledgers track total, committed, reserved, and protected-headroom capacity
- reservation authority is bound to authorized Job + Placement Request + Placement Decision + decision hash + exact selected target
- scoped logical idempotency prevents duplicate capacity consumption
- leases support renewal, release, cancellation, and safe expiry
- requested and granted capacity are both retained; partial grants require explicit authorization
- atomic commit envelopes bind expected ledger revision/hash and, for mutation, the current reservation hash
- the persistence adapter contract must atomically CAS ledger + reservation and enforce unique scoped idempotency; stale conflicts must fail rather than silently retry
- terminal replay does not restore capacity twice
- expired/inactive reservations fail the dispatchability boundary
- pending Allocation records preserve reservation/capacity lineage but do not dispatch
- real transactional persistence and multi-process concurrency proof remain integration work

### Resource economics and simulation foundation

- Phase 35 hash-bound economic snapshots cover owned/committed/reserved/spot/on-demand capacity, utilization, protected headroom, quotas, effective cost, and marginal cost
- the cost governor can only rank resources that already passed Phase 32 hard eligibility
- budget bindings deterministically allow, require approval, or block; economics never overrides data/security/reliability policy
- cost/usage reconciliation compares estimates with actuals without establishing business outcome truth
- Phase 40 simulator reuses the existing Phase 31/32/35 contracts rather than inventing a second policy path
- historical observations and simulation projections are explicitly labeled separately
- simulation emits assumptions, uncertainty, guardrail findings, and advisory scheduler ordering
- AI-recommended simulations must record AI Gateway model/provider/routing-policy evidence
- simulator has no policy mutation, reservation, dispatch, credential lookup, or automatic promotion path

### Verification pipeline

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

3. **Phases 19–23 — durable runtime integration**
   - persistent queues
   - claims/leases/heartbeats
   - retries/dead-letter/cancellation/recovery
   - business adapters
   - software-worker/deployment pipeline
   - persist and connect the existing Phase 22 verification contracts to real verifier sources
   - persist/index the existing Phase 23 advisory memory contracts
   - do not replace the verification receipt or memory authority rules

4. **Provider-connected completion of Phases 24–25**
   - run production auth/RLS/provider/model security tests against real infrastructure
   - connect a real Web Push/VAPID or platform push delivery backend to the existing redacted notification/deep-link contracts
   - connect cryptographic WebAuthn/passkey verification to the existing ceremony boundary
   - preserve the rule that push/deep links/service workers grant navigation only, never approval or execution authority
   - prove phone-off continuity only after the durable job runtime exists

5. **Provider-connected completion of Phases 26–33**
   - connect the existing Phase 26 registry/readiness contracts to production persistence
   - connect the existing Phase 27 enrollment state machine to real provider/device flows
   - build the real Raspberry Pi/Linux agent and cryptographic identity/attestation path
   - connect the existing Phase 29 credential contracts to a production secret backend, provider token exchange, secure delivery, and durable revocation
   - connect Phase 30 profile/health contracts to authenticated live telemetry, benchmarks, and Signal Bus transitions
   - persist Phase 31 policy bindings and prove them against real resource metadata
   - persist Phase 32 placement requests/evaluation snapshots without adding scheduler authority
   - implement the existing Phase 33 AtomicReservationStore against the production database with atomic ledger+reservation writes, scoped idempotency uniqueness, compare-and-swap revision/hash enforcement, durable lease expiry/reaping, and live multi-process race tests
   - do not let an agent/provider/frontend bypass READY, credential, policy, placement, or reservation authority

6. **Provider-connected completion of Phases 34–40**
   - scheduler/dispatch/start verification
   - connect the existing Phase 35 governor to real reservation state, quotas, billing/usage feeds, and durable reconciliations
   - storage fabric
   - failure domains and failover
   - adapter SDK + second provider
   - partner/DC pools
   - connect the existing Phase 40 read-only simulator to durable historical placement/cost/utilization/failure/queue/outcome and AI Gateway analytics
   - calibrate simulation projections against measured outcomes without allowing automatic policy promotion

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
- `docs/SOL_PHASE_24_25_REPORT.md`
- `docs/SOL_PHASE_29_32_REPORT.md`
- `docs/SOL_PHASE_33_REPORT.md`
- `docs/SOL_PHASE_35_40_REPORT.md`
- latest GitHub Actions result

Then continue from the first unblocked canonical phase without silently replacing the authority model.


## September 20 deterministic handoff update

Astra must treat the following as existing architecture, not greenfield work:

- authoritative Event domain and universal transition service;
- hash-bound Authorization Grants and persisted Task authorization consumption;
- Phase 22 verification requests/evidence/receipts and truth transitions;
- Phase 23 advisory operational memory and Context Assembler integration;
- Phase 24 attributed portfolio/security boundaries and adversarial regression suite;
- Phase 25 PWA/service-worker/deep-link/notification/WebAuthn deterministic foundation;
- Phase 26 Resource Registry evidence/readiness contracts and lifecycle service;
- Phase 27 deterministic enrollment state machine and replay-resistant challenge model;
- Phase 29 reference-only secret and minimum-scope credential lease contracts;
- Phase 30 resource profiling, privileged-claim validation, telemetry health, and zero-side-effect simulator;
- Phase 31 deterministic resource/data placement policy;
- Phase 32 control-plane placement requests and explainable candidate eligibility evaluation;
- Phase 33 deterministic atomic reservation/CAS, capacity-ledger, lease, expiry, release, and allocation-lineage contracts;
- Phase 35 deterministic cost/capacity governor and estimate-vs-actual reconciliation;
- Phase 40 read-only policy/economics/scheduler/guardrail simulator with explicit uncertainty and zero side effects.

Canonical PASS for these phases still depends on real persistence/runtime/hardware acceptance where specified by the master plan. The existence of deterministic code is not permission to mark infrastructure-dependent acceptance complete.
