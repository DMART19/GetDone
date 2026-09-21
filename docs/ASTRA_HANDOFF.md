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
- authoritative VerificationSourceBinding + VerificationTrustAttestation contracts; verifier independence is derived from registered source bindings rather than caller-selected evidence strings
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
- Phase 34 deterministic scheduler/dispatch contracts now exist; live dispatch remains integration work

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

### Phase 34 scheduler, dispatch, and verification foundation

- bounded ranking consumes only Phase 32 candidates that Phase 35 currently classifies as autonomous ALLOW; APPROVAL_REQUIRED/BLOCKED resources cannot enter autonomous scheduling
- ranking explicitly scores reliability, locality, cost, startup latency, protected-capacity impact, and owner preference
- placement decisions are hash-bound to request/evaluation/ranking/candidate lineage and remain explainable
- retry/fallback creates a new decision with prior decision ID/hash and an explicit reason
- dispatch requires a live Phase 33 reservation plus matching pending Allocation lineage
- dispatch requires an active Phase 29 CredentialLease for the exact Job/resource/provider/capability
- short-lived DispatchAdmissionReceipt rechecks current policy registry, kill switches, READY/environment permission, Phase 35 governor admission/freshness, reservation, and credential lineage
- dispatch intent is bound to resource adapter/version, credential lease, admission receipt, and reservation expiry
- provider ACCEPTED is evidence only, never running truth
- start verification reuses Phase 22 `resource-start`; VERIFIED receipts must additionally carry a trusted verifier-source attestation whose registered independence domain is separate from dispatch
- verified running/completion records explicitly do not mutate Job truth; JobService remains authoritative
- the deterministic Phase 34 → JobService bridge now exists: JobService claimed → running requires a persisted `JobVerifiedStartFact`; running → verifying requires the matching persisted `JobVerifiedCompletionFact`; provider ACCEPTED is never Job authority
- final Job success still requires the existing authoritative Job verification receipt
- completion release calls the unchanged Phase 33 release contract
- deterministic scheduler audit entries carry explanation plus hash lineage
- live adapter calls, durable scheduler state, real start probes, crash recovery, and production fallback remain integration work

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

### Phase 41 release/version evidence foundation

- committed registry declares app/schema/database/policy/adapter/AI-routing/environment/evidence/manual anatomy
- missing live database/AI/provider infrastructure is represented explicitly as UNIMPLEMENTED/UNCONFIGURED rather than inferred
- generated release manifest binds the exact checked-out Git SHA, package lock, source hashes, CI run evidence, environment manifest, evidence docs, and generated manual
- generated operating manual is human-readable release anatomy and contains no raw credentials
- CI generates, verifies, and archives release evidence after the production build gate
- future agents should read `release/version-registry.json` before changing versioned contracts and regenerate/verify release evidence before handoff

### Phase 42 voice handoff boundary

- treat `lib/voice/voice-intents.ts` as the authoritative provider-neutral voice contract
- speech/NLU output is evidence only; it never supplies trusted scope or policy authority
- preserve `canApprove=false`, `canStepUp=false`, `canExecuteSideEffect=false`, and `canAcceptRawCredentials=false`
- any live native/Siri/speech integration must return typed candidates into this boundary rather than directly invoking workers or approval APIs
- sensitive setup, strong approval, and credentials remain secure-phone/provider flows
- update `release/version-registry.json` and `release/environment-manifest.json` when a real adapter/provider becomes connected; do not invent versions before then

### Verification pipeline

CI runs install, runtime verification, secret-pattern scan, architecture drift verification, typecheck, lint, tests, build, Phase 41 release generation/validation, and evidence archival. Do not bypass those gates.

## Owner-action blockers before canonical Phase 2/3 PASS

1. Select/provision the real authentication/session implementation.
2. Select/provision the authoritative database.
3. Add real migrations and RLS/authorization rules.
4. Run real session revocation, tenant isolation, and cross-company leakage tests.

Do not invent a provider and do not mark these phases PASS until those acceptance checks are real.

## Work reserved for Astra

Once the owner/infrastructure blockers are resolved, Astra should focus its higher-compute budget on the work that benefits from it:

1. **Phase 13 — provider-connected completion**
   - preserve the existing `lib/ai-gateway` contracts/router/budget/audit layer
   - add the OpenRouter server-side adapter and secure credential binding
   - run real capability/provider/model canaries and populate validated ModelProfiles
   - populate live model-role routing configuration
   - connect persistent budget/usage/rate/concurrency state
   - do not move eligibility, fallback safety, kill-switch handling, schema validation, or audit authority into OpenRouter

2. **Phase 4 + provider-connected completion of Phases 14–17**
   - connect real company integration OAuth/API adapters to the existing Company Integration Registry
   - persist integration records and provider authentication evidence with tenant/environment isolation
   - keep read/write scopes and credential references separate

   - route model-originated proposals through the production AI Gateway and the existing GetDone-owned plan schema
   - bind policy/approval state to the real auth/session/database implementation
   - persist task-deduplication and authorization lineage atomically
   - preserve the existing validator, policy engine, task generator, and DAG compiler rather than replacing them

3. **Phases 19–23 — provider-connected durable runtime integration**
   - implement the existing DurableJobStore against real persistent queue/database infrastructure
   - preserve existing claim/lease/heartbeat/retry/dead-letter/cancellation/recovery contracts
   - implement real business adapters against the existing adapter/conformance boundary
   - connect the existing software-worker/deployment state/evidence contracts to GitHub/build/staging/production/rollback infrastructure
   - persist and connect the existing Phase 22 verification contracts to real verifier sources
   - persist/index the existing Phase 23 advisory memory contracts
   - do not replace the verification receipt or memory authority rules

4. **Provider-connected completion of Phases 24–25**
   - run production auth/RLS/provider/model security tests against real infrastructure
   - connect a real Web Push/VAPID or platform push delivery backend to the existing redacted notification/deep-link contracts
   - connect cryptographic WebAuthn/passkey verification to the existing ceremony boundary
   - preserve the rule that push/deep links/service workers grant navigation only, never approval or execution authority
   - prove phone-off continuity only after the durable job runtime exists

5. **Provider-connected completion of Phases 26–34**
   - connect the existing Phase 26 registry/readiness contracts to production persistence
   - connect the existing Phase 27 enrollment state machine to real provider/device flows
   - build the real Raspberry Pi/Linux agent and cryptographic identity/attestation path
   - connect the existing Phase 29 credential contracts to a production secret backend, provider token exchange, secure delivery, and durable revocation
   - connect Phase 30 profile/health contracts to authenticated live telemetry, benchmarks, and Signal Bus transitions
   - persist Phase 31 policy bindings and prove them against real resource metadata
   - persist Phase 32 placement requests/evaluation snapshots without adding scheduler authority
   - implement the existing Phase 33 AtomicReservationStore against the production database with atomic ledger+reservation writes, scoped idempotency uniqueness, compare-and-swap revision/hash enforcement, durable lease expiry/reaping, and live multi-process race tests
   - connect the existing Phase 34 ResourceDispatchAdapter contract to real resource/provider adapters, persist placement/dispatch/monitor records, and feed independent start/completion probes into VerificationService
   - implement the existing `JobExecutionBridgeStore` durably inside the authoritative control-plane persistence model
   - persist verified-start/completion facts before invoking the existing JobService bridge transitions; preserve exact running-placement lineage and fact hashes
   - prove crash/restart recovery across verified placement -> bridge fact -> Job transition without replaying side effects
   - never restore a direct provider-accepted -> Job running path; final success still requires an authoritative Job verification receipt
   - prove crash recovery for reserve -> dispatch -> start verify -> monitor -> completion verify -> release, including provider timeouts and lease expiry
   - do not let an agent/provider/frontend bypass READY, credential, policy, placement, reservation, dispatch, or verification authority

6. **Provider-connected completion of Phases 35–40**
   - connect the existing Phase 35 governor to real reservation state, quotas, billing/usage feeds, and durable reconciliations
   - connect the existing Phase 36 Storage Fabric contracts to real Home NAS/cloud/backup/archive storage, replication, checksum, restore, and measured RPO/RTO
   - connect the existing Phase 37 failure-domain/drain/failover contracts to real telemetry, reroute, checkpoint recovery, and verified post-failover health
   - implement a real second provider against the existing Phase 38 Resource Adapter SDK/conformance boundary rather than adding provider logic to scheduler/business code
   - connect the existing Phase 39 ResourcePool contracts to real partner/colo aggregate discovery, quotas, cost, credentials, health, capacity, and workload state
   - connect the existing Phase 40 read-only simulator to durable historical placement/cost/utilization/failure/queue/outcome and AI Gateway analytics
   - calibrate simulation projections against measured outcomes without allowing automatic policy promotion

7. **Provider-connected completion after deterministic Phases 41–42**
   - preserve and populate the existing release/version registry with real DB migration, deployment, AI Gateway/routing, adapter, voice, and environment versions as integrations become real
   - archive real staging/production deployment evidence through the existing Phase 41 manifest/manual path
   - connect the existing Phase 42 VoiceIntentAdapter contract to live speech/native-iPhone transport while preserving secure-phone approval/credential handoff
   - Phase 43 optional Watch
   - extend the existing Phase 44 deterministic attack matrix with live adapters and run the full adversarial/end-to-end production acceptance

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
- `docs/SOL_PHASE_34_REPORT.md`
- `docs/SOL_PHASE_35_40_REPORT.md`
- `docs/SOL_ARCHITECTURE_INTEGRITY_REPORT.md`
- `docs/SOL_PHASE_41_REPORT.md`
- `docs/SOL_PHASE_42_REPORT.md`
- `docs/SOL_QUALITY_PHASE_4_13_19_21_REPORT.md`
- `docs/SOL_PHASE_36_39_44_REPORT.md`
- `docs/SOL_GOLDEN_PATH_JOB_BRIDGE_REPORT.md`
- `release/version-registry.json`
- `release/environment-manifest.json`
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
- Phase 34 deterministic Phase-35-governed ranking, placement decisions, Phase-33 reservation + Phase-29 credential + final-admission-gated dispatch, trusted start/completion verification, monitoring, release, retry/fallback lineage, and scheduler audit contracts;
- Phase 35 deterministic cost/capacity governor and estimate-vs-actual reconciliation;
- Phase 40 read-only policy/economics/scheduler/guardrail simulator with explicit uncertainty and zero side effects;
- Phase 41 machine-readable release/version registry, explicit environment/deployment state, Git-SHA-bound manifest/manual generator, release validator, and CI evidence archive;
- Phase 42 typed voice-intent/adapter contracts, transcript-hash-only evidence, Control API/current-policy binding, secure phone handoff, no voice approval/step-up/execution/raw-credential authority, scoped audit, and Phase-41 version/environment/evidence bindings;
- quality/integrity tranche: stable Resource Fabric barrels/internal split, dependency-boundary matrix, contract-version drift gate, module/test coverage thresholds, adversarial contract vectors;
- Phase 4 deterministic Company Integration Registry;
- Phase 13 deterministic provider-neutral AI Gateway contract/router/budget/audit layer;
- Phase 19 durable Job runtime/store contracts;
- Phase 20 business action adapter/conformance contracts;
- Phase 21 software-worker/deployment authorization/evidence contracts;
- Phase 36 deterministic Storage Fabric placement/replication/authority contracts;
- Phase 37 failure-domain/drain/failover contracts;
- Phase 38 Resource Adapter SDK/conformance contract and DEVELOPMENT mock;
- Phase 39 governed aggregate ResourcePool contracts;
- Phase 44 deterministic offline adversarial harness covering the current authority boundaries;
- authoritative Phase 34 → JobService verified-start/completion bridge contracts and JobService enforcement;
- deterministic 19-stage cross-phase golden-path composition harness, explicitly simulation-only and non-production.

Canonical PASS for these phases still depends on real persistence/runtime/hardware acceptance where specified by the master plan. The existence of deterministic code is not permission to mark infrastructure-dependent acceptance complete.
