# Sol Upgrade Implementation Status

This file tracks code actually implemented from `SOL_UPGRADE_EXECUTION_PLAN.md`. It does not replace canonical phase reports and it does not label infrastructure-dependent phases PASS before their real acceptance evidence exists.

## Implemented in code

### SOL-1 — Phase 1B screenshot fidelity

- Added dedicated UFO v2 fidelity styling.
- Tightened the owner shell around iPhone-sized composition.
- Preserved permanent navigation as Chat | Decisions | Resources.
- Made the DEVELOPMENT marker non-layout-disruptive.
- Added screenshot-style Add Resource Cancel behavior.
- Reordered Resource Detail to identity -> Actions -> tabs -> metrics -> metadata -> capabilities -> workloads.
- Expanded screenshot-style seeded Decisions content and priority counts.
- Preserved the screenshot-simple experience instead of turning Resources into an infrastructure console.

### SOL-2 — Phase 1C UI state hardening

- Added route loading, error, and not-found states.
- Added reduced-motion and focus-visible handling.
- Added skeleton loading presentation.
- Added `docs/VISUAL_ACCEPTANCE.md`.

### SOL-3 — Control API foundation

- Added typed control-plane errors.
- Added correlation/environment/idempotency request helpers.
- Added typed success/error API envelopes.
- Added runtime parsing for decision-action requests.
- Added a provider-neutral Control API transport contract.
- Aligned the development client with the API envelope.
- Added a provider-neutral owner read-repository seam.
- Owner Resources/Decisions/detail pages no longer import seed arrays directly.
- DEVELOPMENT seed data fails closed on a production owner surface.
- Development resource/decision APIs now return correlation IDs and typed envelopes.
- Health API explicitly reports that auth, persistence, AI gateway, durable jobs, and authoritative control plane are not connected.

### SOL-4 — Authentication architecture scaffold

- Added `AuthAdapter`, `AuthSession`, `StepUpChallenge`, passkey descriptor, and auth-requirement contracts.
- Added active-session validation.
- Added expiration and revocation handling.
- Added independent fresh step-up validation.
- Added a server-request authorization helper.
- Added unit tests for session authority.
- Real provider/session persistence remains an owner/infrastructure checkpoint.

### SOL-5 — Tenant-scope foundation

- Added trusted membership/scope guard.
- Added portfolio/company/resource ID-tampering tests.
- Added revoked-membership denial.
- Real User -> Portfolio -> Company persistence and RLS remain blocked on database selection.

### SOL-6 — Deterministic authority foundation

- Added typed capability registry with fail-closed lookup.
- Added examples for business, software, compute, storage, and resource-health capabilities.
- Added objective/guardrail domain types, pause semantics, and conflict detection.
- Added explicit state-transition maps for Goal, Plan, Decision, Approval, Task, Job, Resource, and Reservation.
- Added transition records carrying actor, scope, trigger, and timestamp.
- Added audit-event contract.
- Added idempotency store contract and conflict handling.
- Added global/portfolio/company/integration/capability/resource/pool/provider/failure-domain/workload-class kill switches.
- Added a deterministic side-effect preflight contract requiring authentication, typed capability, trusted scope, policy, authorization, idempotency, timeout, retry, audit, and verification.
- Added tests for capabilities, objectives/guardrails, state transitions, idempotency, kill switches, and side-effect admission.

### SOL-7 — Deterministic intelligence substrate

- Added normalized signal model.
- Added deterministic signal classification and attention actions.
- Added signal deduplication, freshness checks, and investigation cooldown behavior.
- Added external-research mission/evidence contracts with freshness, confidence, relevance, and scope.
- Added bounded scoped context assembly with portfolio/company/sensitivity filtering and character limits.
- Added tests for signal escalation/dedupe/cooldown, research scope/freshness, and cross-company context isolation.

### SOL-8 — Signal intelligence hardening

- Added transactional Signal Bus contracts for trusted-scope ingestion, dedupe, normalized signals, and out-of-order cursors.
- Added company/resource sensing profiles, deterministic thresholds, freshness/cooldowns, and Investigation creation.
- Added advisory research quotas/failure isolation.
- Added fresh, scope-aware, resource-authorized context sections.
- See `docs/PHASE_9_12_REPORT.md`.

### SOL-10 — Deterministic planning and compilation

- Added GetDone-owned structured plan schema for objectives/investigations/owner requests.
- Added server-authorized plan scope/source construction boundary.
- Added deterministic plan validation for capability fit, dependency graphs, contradictions, costs, environment/data/region, reliability, fallback, credentials, and rollback requirements.
- Added deterministic policy outcomes: AUTO, APPROVAL_REQUIRED, STRONG_APPROVAL, BLOCKED.
- Policy evaluation includes capability rules, environment/data/region, guardrails, budgets, kill switches, credentials, protected headroom, fallback, idempotency, approval state, and fresh step-up.
- Added immutable autonomous task generation with authorization lineage and semantic SHA-256 logical deduplication.
- Added deterministic executable DAG compilation with cycle/unsatisfied-dependency rejection, typed capability mapping, runtime capability-input validation, preconditions, verification nodes, rollback/cancellation semantics, and resource requirement envelopes.
- Resource selection and durable dispatch remain explicitly deferred.
- See `docs/PHASE_14_18_DETERMINISTIC_REPORT.md`.

### SOL-9 — CI/security hardening

- Upgraded the project from vulnerable Next.js 15.5.2 to the patched 15.5.25 release line.
- Pinned CI to Node 24.
- Added Vitest path-alias configuration.
- Added secret-pattern scanning to CI.
- CI now runs install -> secret scan -> typecheck -> lint -> unit tests -> production build.
- Multiple consecutive CI runs have passed after the Vitest/CI bootstrap fixes.

## Verification state

Verified in GitHub Actions after the CI repair:

- dependency installation
- secret-pattern scan
- TypeScript typecheck
- ESLint
- Vitest unit tests
- Next.js production build

The visual screenshot checklist remains a human/visual review item; automated CI passing is not treated as proof of pixel-level visual fidelity.

## Owner action still required

Canonical Phase 2 cannot PASS until a production authentication/session implementation is chosen, provisioned, connected, and tested.

Canonical Phase 3 cannot PASS until an authoritative database/persistence target is chosen and real migrations/RLS/tenant-isolation tests run against it.

No production secret should be committed to this repository or pasted into frontend configuration.

## Astra handoff still deferred

No production AI gateway, autonomous planning runtime, durable distributed job engine, real resource enrollment agent, credential broker, scheduler, reservations/capacity ledger, provider failover, or production Resource Fabric behavior has been claimed as implemented.

Astra should inherit the deterministic foundation rather than recreate it.


## September 20 authority + Phase 22/23/26/27 tranche

The repository has advanced beyond the earlier status snapshot. The following deterministic work is now implemented in addition to the sections above.

### Authority hardening after SOL-20

- Events are a first-class authoritative control-plane domain.
- Goal, Plan, Decision, Approval, Task, Job, Outcome, and Event transitions use the common authoritative transition boundary.
- Authorization grants are hash-bound to trusted scope, Plan/step hashes, capability set, validation receipt, policy snapshot, proof state, issue/expiry time, and grant integrity hash.
- Authorization consumption is recorded authoritatively at Task admission and inherited by Jobs only from persisted Task consumption.
- Strong approval proof freshness and validator-attestation authority are tested.
- Current head before this tranche passed the complete CI pipeline.

### Phase 22 — Verification, Measurement, and Outcomes

**STATUS: DETERMINISTIC SUBSET IMPLEMENTED; PRODUCTION PERSISTENCE/RUNTIME ACCEPTANCE STILL REQUIRED**

Implemented:
- VerificationRequest, VerificationEvidence, VerificationStrategyResult, and VerificationReceipt contracts.
- execution/system/business/resource-start/resource-release/cost-reconciliation verification strategies.
- SHA-256 integrity binding for requests, evidence, and receipts.
- evidence freshness and expiry.
- independent-verifier domain enforcement.
- verified / failed / uncertain deterministic verdicts.
- authoritative Verification state transitions and audit path.
- Task, Job, and Outcome truth transitions now require scoped, non-expired verification receipts rather than arbitrary evidence IDs.

Not yet claimed:
- external production verifier adapters;
- durable evidence/receipt persistence;
- real business KPI measurement sources;
- production resource start/release/cost reconciliation.

### Phase 23 — Memory and Operational Learning

**STATUS: DETERMINISTIC SUBSET IMPLEMENTED**

Implemented:
- scoped Fact, Lesson, Experiment, Observation, and OutcomeReference records;
- confidence, sample size, confounders, evidence, sensitivity, relevance tags, expiry, and supersession;
- record integrity hashing;
- deterministic relevance selection;
- strict company isolation;
- operational-memory -> bounded Context Assembler integration;
- memory is permanently advisory and has no policy/authorization authority.

Not yet claimed:
- production persistence/indexing;
- long-horizon experimentation jobs;
- automatic policy promotion (intentionally prohibited).

### Phase 26 — Resource Domain and Authoritative Registry

**STATUS: DETERMINISTIC SUBSET IMPLEMENTED**

Implemented:
- identity evidence;
- trust evidence;
- health records;
- validated capability bindings;
- resource locations/failure-domain metadata;
- cost profiles;
- provider/adapter bindings;
- evidence-backed readiness evaluation;
- authoritative resource lifecycle service;
- concise resource read model for the owner surface.

A Resource cannot deterministically qualify for READY without verified identity, non-untrusted trust classification, fresh healthy status, validated capabilities, location, environment permission, policy binding, and active authenticated provider/adapter binding.

Not yet claimed:
- production registry persistence;
- real cryptographic agent identity;
- live telemetry;
- real provider discovery.

### Phase 27 — Generic Resource Enrollment

**STATUS: DETERMINISTIC SUBSET IMPLEMENTED**

Implemented lifecycle:

`IDENTIFY -> CREATE_ENROLLMENT -> OWNER_ACTION(if required) -> AUTHENTICATE -> DISCOVER -> PROFILE -> VALIDATE -> TEST -> REGISTER -> READY`

Implemented:
- server-side hashed one-time challenge storage;
- challenge expiration and replay prevention;
- trusted portfolio/company scope;
- owner-action evidence;
- evidence at every material stage;
- cancellation / expiration / failure;
- deterministic restart with a new challenge and incremented attempt;
- authoritative lifecycle audit transitions.

Not yet claimed:
- Raspberry Pi/Linux agent;
- real provider OAuth/device flows;
- hardware canary;
- live registry/persistence integration.


## September 20 Phase 24/25 deterministic tranche

### Phase 24 — Portfolio Intelligence and Security Hardening

**STATUS: DETERMINISTIC SUBSET IMPLEMENTED; PRODUCTION INFRASTRUCTURE/EXTERNAL RED-TEAM ACCEPTANCE STILL REQUIRED**

Implemented:
- company-attributed portfolio executive summaries with explicit authorized-company scope;
- latest-fresh-snapshot selection and no cross-portfolio/cross-company leakage;
- external authority boundary preventing AI/model/gateway/provider/callback/frontend/resource-agent claims from directly establishing approval, authorization, job success, outcome truth, resource READY, policy mutation, credential expansion, or production deployment authority;
- reserved authority-field rejection for untrusted nested payloads;
- deterministic production-promotion boundary requiring control-plane source, trusted scope, policy authorization, verified approval, fresh deployment verification, deployment reference, and rollback reference;
- consolidated automated adversarial regression coverage across session expiry, tenant scope, forged callbacks, credential scope, cross-company context contamination, external authority forgery, provider kill switches, and production-promotion boundaries;
- Resource Fabric adversarial placeholders/tests for resource impersonation, fake enrollment readiness, forged heartbeat, capacity spoofing, reservation replay, and scheduler bypass.

Not yet claimed:
- real production auth/database/RLS penetration results;
- live AI Gateway model-substitution/fallback red-team execution;
- provider-specific credential/secret systems;
- external penetration testing;
- real production deployment executor.

### Phase 25 — PWA Packaging, Push, and Mobile Delivery

**STATUS: DETERMINISTIC/CLIENT-RUNTIME SUBSET IMPLEMENTED; REAL PUSH/AUTH PROVIDERS STILL REQUIRED**

Implemented:
- standalone PWA manifest scope/id/orientation metadata;
- iPhone web-app metadata and safe-area-compatible existing viewport;
- service-worker registration with explicit update-available signaling;
- reconnect signaling for authoritative server re-fetch behavior;
- service worker that caches only the offline shell/icon and never caches `/api/*` responses or authenticated application state;
- network-first navigation with explicit offline fallback;
- generic/redacted service-worker push presentation and notification-click deep links;
- safe typed deep-link contracts covering Decision, Task/Result, Resource, Resource Incident, and Resource Decision;
- deep links are navigation-only and always require authoritative server fetch;
- deterministic notification attention routing: FYI/Normal remain non-push, High/Critical qualify for push;
- lock-screen detail redaction for sensitive/high-attention content;
- deterministic PWA update policy that defers reload while offline, during unsaved owner input, or during strong approval;
- WebAuthn ceremony boundary enforcing expiry, RP ID, allowed origin, credential identity, and user verification;
- baseline response/security headers and service-worker no-cache policy.

Not yet claimed:
- VAPID/APNs/Web Push subscription backend;
- notification persistence/delivery receipts;
- cryptographic WebAuthn assertion/attestation verification by a real auth provider;
- production secure-session persistence;
- durable cloud jobs required to prove the phone-off acceptance criterion;
- native Watch support.

See `docs/SOL_PHASE_24_25_REPORT.md`.


## September 20 Phase 29–32 deterministic Resource Fabric tranche

### Phase 29 — Secrets and Credential Broker

**STATUS: DETERMINISTIC CONTRACT/ISSUANCE SUBSET IMPLEMENTED; REAL SECRET BACKEND/TOKEN EXCHANGE STILL REQUIRED**

Implemented:
- reference-only SecretReference records; raw secret values are not modeled;
- scoped CredentialBinding records for company, provider, environment, capability, scopes, resources, and location classes;
- authoritative control-plane CredentialRequest records bound to job, placement request, and trusted resource scope;
- minimum-scope CredentialLease issuance with SHA-256 integrity, bounded TTL, expiry, revocation, and release;
- secure-delivery references instead of credential material;
- credential usage audit records;
- deterministic denial for cross-company, cross-environment, wrong-location, disabled/non-READY resource, expired, or over-broad requests.

Not yet claimed:
- Vault/KMS/Secrets Manager or equivalent production backend;
- provider token exchange/OAuth refresh;
- encrypted transport of material to a real resource agent;
- durable lease/revocation persistence;
- live OpenRouter credential issuance.

### Phase 30 — Resource Profiling, Capability Validation, and Telemetry

**STATUS: DETERMINISTIC PROFILE/HEALTH/SIMULATOR SUBSET IMPLEMENTED; LIVE AGENT TELEMETRY STILL REQUIRED**

Implemented:
- normalized resource profile claims for architecture, CPU, memory, GPU/VRAM, disk, network, runtime/software, benchmark/latency/uptime, thermal, and power fields;
- hash-bound independent capability validation evidence;
- privileged GPU/production/authoritative-storage capability claims require independent validation;
- fabricated GPU hardware is removed from the validated profile without proof;
- authenticated telemetry health summarization;
- fresh HEALTHY, DEGRADED, SATURATED, and safe UNREACHABLE behavior for stale/missing heartbeat telemetry;
- unauthenticated telemetry cannot establish health;
- deterministic zero-side-effect telemetry simulator for healthy/degraded/saturated/stale/heartbeat-loss test scenarios.

Not yet claimed:
- Raspberry Pi/Linux agent telemetry transport;
- real benchmark probes/hardware attestation;
- persistent time-series telemetry;
- production Signal Bus emission from live health transitions;
- hardware canary acceptance.

### Phase 31 — Resource Policy and Data Classification

**STATUS: DETERMINISTIC HARD-CONSTRAINT POLICY IMPLEMENTED**

Implemented:
- canonical data classes: PUBLIC, INTERNAL, CUSTOMER, SENSITIVE, PRODUCTION_CRITICAL, REBUILDABLE, TEMPORARY, ARCHIVE, BACKUP, MODEL_ARTIFACT;
- location classes: HOME, OFFICE, CLOUD, COLO, PARTNER_DC;
- dev/staging/production, data-class, location, region, reliability, encryption, fallback, interruption, and workload allow/deny rules;
- default deny for production CUSTOMER/SENSITIVE data on HOME unless explicitly authorized;
- default deny for a sole PRODUCTION_CRITICAL authoritative copy in HOME;
- deterministic explainable reasons;
- preference hints are separated from hard eligibility so speed/price cannot override policy.

### Phase 32 — Placement Request and Candidate Evaluation

**STATUS: DETERMINISTIC ELIGIBILITY SUBSET IMPLEMENTED; NO RESERVATION OR DISPATCH**

Implemented:
- placement requests can only originate from an authorized control-plane job;
- request scope includes capability/compute envelope, priority/deadline, checkpoint/retry, data class, regions/locality, reliability/fallback, max cost, pin/exclusions, idempotency key, and expiry;
- SHA-256 request integrity and candidate snapshot integrity;
- active logical idempotency reuse and conflict rejection;
- deterministic candidate filters in canonical order: scope -> policy -> health -> capability/profile -> capacity -> credential/environment -> cost;
- request-specific region, reliability, and fallback hard constraints;
- every rejection carries explicit reason codes and snapshot hash lineage;
- pinned resources still pass every hard constraint;
- eligible candidates include a deterministic explanation sufficient to answer why the resource qualified;
- no reservation, allocation, ranking, or dispatch is performed.

Still deferred from Phase 32 itself:
- Phase 33/34 production persistence and runtime acceptance evidence.
- deterministic Phase 33/34 contracts now exist separately and do not change Phase 32 eligibility authority.

See `docs/SOL_PHASE_29_32_REPORT.md`.



## September 20 Phase 33 deterministic reservation + capacity-ledger tranche

### Phase 33 — Reservation, Allocation, and Capacity Ledger

**STATUS: DETERMINISTIC CONCURRENCY CONTRACTS IMPLEMENTED; REAL TRANSACTIONAL PERSISTENCE/CONCURRENCY ACCEPTANCE STILL REQUIRED**

Implemented:
- resource and pool capacity ledgers with total, committed, reserved, and protected-headroom vectors;
- SHA-256 ledger integrity plus monotonically increasing ledger revisions;
- control-plane-only reservation authority bound to authorized Job, Placement Request, Placement Decision, Placement Decision hash, and exact selected resource/pool target;
- requested-versus-granted capacity tracking with fail-closed partial-grant behavior unless explicitly authorized;
- reservation leases with issue/expiry, renewal, cancellation, explicit release, and safe stale/abandoned expiry;
- active reservation state carries capacity-held truth; terminal states cannot retain capacity;
- scoped logical idempotency hash and deterministic replay without double reservation;
- idempotency-key reuse with different logical requirements is rejected;
- atomic commit envelopes bind expected ledger revision/hash, expected current reservation hash for mutations, next ledger revision/hash, next reservation hash, operation, and transaction hash;
- production store contract requires one atomic transaction, unique scoped idempotency, ledger CAS, reservation-hash CAS, and conflict return rather than stale automatic retry;
- stale concurrent writers fail closed on ledger revision mismatch;
- refreshed callers still cannot consume protected headroom or exceed available capacity;
- release/cancel/expire restores granted capacity exactly once under deterministic replay;
- expired/inactive reservations cannot pass the dispatchability boundary;
- pending Allocation records can be created only from a live unexpired reservation and carry reservation hash/capacity lineage;
- no dispatch/worker/provider execution authority is added.

CI/adversarial coverage includes:
- two concurrent callers racing from the same ledger revision;
- refreshed over-allocation after the first reservation wins;
- idempotent reservation replay;
- conflicting idempotency reuse;
- unauthorized partial grants;
- lease renewal without double reservation;
- abandoned lease expiry restoring capacity;
- expired reservation dispatch/allocation rejection;
- exactly-once release replay;
- cancellation-versus-release conflict;
- resource and pool ledger behavior;
- cross-company/wrong-placement-target authority rejection;
- atomic commit tamper detection.

Not yet claimed:
- real PostgreSQL/Supabase/other transactional reservation tables;
- production row locks/serializable transactions/advisory locks;
- multi-process concurrency acceptance against a live database;
- durable lease sweeper/reaper;
- live resource-provider capacity mutation.
- deterministic Phase 34 now consumes these contracts, but production dispatch still depends on the live Phase 33 store.

See `docs/SOL_PHASE_33_REPORT.md`.


## September 20 Phase 34 deterministic scheduler + dispatch tranche

### Phase 34 — Scheduler Dispatch, Start Verification, and Release

**STATUS: DETERMINISTIC SCHEDULER/DISPATCH/VERIFICATION CONTRACTS IMPLEMENTED; LIVE ADAPTER/PERSISTENCE/RUNTIME ACCEPTANCE STILL REQUIRED**

Implemented:
- bounded scheduler scoring uses explicit reliability, locality, cost, startup-latency, protected-capacity-impact, and owner-preference weights;
- scheduler ranks only candidates already marked eligible by the authoritative Phase 32 PlacementEvaluationReport;
- ineligible candidates are ignored and cannot be selected by explicit override;
- scheduler candidate snapshots are hash-bound, freshness-checked, and bound to the exact Phase 32 candidate snapshot hash;
- placement decisions are hash-bound to Placement Request, Placement Evaluation, Scheduler Ranking, selected candidate snapshots, score, rationale, and decision time;
- retry/fallback requires a new placement decision ID plus prior decision ID/hash and an explicit reason; policy/evaluation lineage cannot silently change;
- helper converts a valid Phase 34 decision into the existing Phase 33 ReservationAuthority without changing Phase 33 contracts;
- dispatch intent requires a live unexpired Phase 33 reservation and matching pending Allocation record;
- dispatch intent is bound to decision, reservation, allocation, resource adapter/version, idempotency key, lease expiry, and SHA-256 integrity;
- resource-adapter results can be accepted/rejected and are hash-bound, but provider ACCEPTED does not establish running truth;
- start verification requests use the existing Phase 22 `resource-start` strategy, require independent evidence, and bind `executionIndependenceKey` to the dispatch hash;
- provider self-evidence with the same dispatch independence key is excluded by the existing verification engine;
- only a fresh VERIFIED independent `resource-start` receipt for the allocation creates `running-verified`;
- a start receipt arriving after reservation expiry fails closed;
- verified running records retain decision/reservation/allocation/dispatch/receipt hash lineage and explicitly set `jobStateMutationApplied: false`;
- monitoring records are hash-bound to the verified running placement;
- completion verification uses independent `execution` evidence for the allocation;
- verified completion also has `jobStateMutationApplied: false`; JobService remains authoritative for Job state transitions;
- verified completion releases capacity by calling the unchanged Phase 33 `releaseReservation` contract, preserving exact-once replay/CAS semantics;
- deterministic scheduler audit records require explanations plus related hash lineage.

CI/adversarial coverage includes:
- eligible-only ranking and forbidden-candidate selection rejection;
- retry/fallback creates a new auditable decision with unchanged policy/evaluation lineage;
- dispatch preserves Phase 33 decision/reservation/allocation lineage;
- expired reservation cannot dispatch;
- provider ACCEPTED alone resolves start as UNCERTAIN and cannot create running truth;
- fresh independent start evidence can create a verified running placement;
- delayed start verification after lease expiry fails closed;
- monitoring/completion verification does not mutate Job truth;
- verified completion releases capacity through Phase 33 and restores ledger capacity;
- exact-once Phase 33 release replay remains intact;
- scheduler audit entries are explainable and hash-bound.

Not yet claimed:
- live ResourceDispatchAdapter implementation;
- durable scheduler/placement/dispatch/monitor state;
- real system probes or resource-agent start verification;
- real completion monitoring/verification sources;
- real JobService integration that transitions claimed -> running only after verified resource start;
- crash recovery between reserve/dispatch/verify/release;
- production fallback across real providers/resources;
- production Phase 33 transactional persistence and multi-process reservation proof.

See `docs/SOL_PHASE_34_REPORT.md`.

## September 20 Phase 35/40 deterministic economics + simulation tranche

### Phase 35 — Cost and Capacity Governor

**STATUS: DETERMINISTIC GOVERNOR SUBSET IMPLEMENTED; LIVE RESERVATION/SCHEDULER/USAGE PERSISTENCE STILL REQUIRED**

Implemented:
- capacity-economic classes for owned, committed, reserved, spot/preemptible, and variable/on-demand capacity;
- hash-bound economic snapshots with total/used/reserved/requested capacity, protected headroom, quotas, effective cost, marginal cost, utilization, freshness, and expiry;
- economics consumes Phase 32 placement eligibility and cannot promote a policy-ineligible candidate;
- protected headroom and quotas block candidates even when they are cheap;
- budget bindings support hard cap BLOCKED and approval-threshold APPROVAL_REQUIRED outcomes;
- deterministic ranking exists only for budget-allowed, already-placement-eligible candidates;
- ranking uses estimated effective cost, marginal cost, utilization, and deterministic resource-id tie breaking;
- estimated versus actual job/resource cost and usage reconciliation with hash-bound variance records.

Not yet claimed:
- Phase 33 real transactional persistence and live multi-process concurrency evidence;
- Phase 34 live adapter/persistence/start-probe integration;
- live provider billing feeds or durable cost/usage persistence;
- actual capacity commitment purchases or provider quota mutation.

### Phase 40 — Resource Intelligence and Zero-Side-Effect Policy Simulator

**STATUS: DETERMINISTIC READ-ONLY SIMULATOR IMPLEMENTED; LIVE HISTORICAL STORES/MEASURED OUTCOME LOOP STILL REQUIRED**

Implemented:
- read-only scoped historical analysis for placement cost, utilization, queueing, failure, verified outcomes, and AI Gateway route/cost/latency/success observations;
- explicit `historical-summary` versus `simulation-projection` labels so projections are not presented as facts;
- policy simulation reuses Phase 31 hard policy and Phase 32 candidate evaluation;
- economic simulation reuses Phase 35 budget/headroom/quota governor;
- deterministic scheduler-preference simulation uses cost/reliability/capacity weights but has no placement authority;
- proposed guardrails can test minimum eligible candidates/capacity, maximum projected failure rate, and maximum expected cost;
- assumptions and low/medium/high uncertainty are emitted with sample-size reasons;
- AI-recommended simulations require recorded AI Gateway request/provider/model/routing-policy evidence;
- cross-company historical observations are excluded from analysis;
- result hard-codes no policy mutation, no reservation, no dispatch, no secret lookup, no automatic policy promotion, and an empty side-effects set.

Not yet claimed:
- production historical warehouse/time-series analytics;
- live AI Gateway recommendation invocation;
- measured production simulation-vs-outcome calibration;
- automatic policy promotion (intentionally prohibited);
- any reservation, dispatch, or policy mutation path.

See `docs/SOL_PHASE_35_40_REPORT.md`.


## September 20 Architecture Integrity tranche

**STATUS: DETERMINISTIC CROSS-PHASE COMPOSITION HARDENED; PRODUCTION RUNTIME GAPS REMAIN EXPLICIT**

Implemented:
- authoritative `VerificationSourceBinding` records bind verifier source type/ID, company/environment scope, allowed strategies, status, validity window, and an authoritative independence domain;
- `VerificationTrustAttestation` verifies receipt/evidence/source-binding lineage and rejects caller-invented independence keys;
- evidence must still be fresh when the trust attestation is created;
- Phase 34 scheduler ranking now consumes the Phase 35 `CostGovernorReport`;
- only Phase-35 `allow` candidates may enter autonomous scheduler ranking;
- Phase-35 `approval-required` and `blocked` candidates are explicitly separated from autonomous ranking;
- cost-governor reports now carry evaluated/expiry windows and fail closed when stale;
- Phase 34 placement decisions bind the Phase 35 governor report hash;
- final dispatch requires an active Phase 29 CredentialLease for the exact company/environment/Job/resource/provider/capability and Placement Request;
- `DispatchAdmissionReceipt` rechecks live Phase 33 reservation/allocation lineage, READY state, environment permission, current policy-registry reference, Phase 35 admission/freshness, Phase 29 credential freshness/scope, and current kill switches;
- dispatch-admission expiry is bounded by the earliest reservation, credential, governor, or receipt TTL;
- dispatch intent records credential lease and dispatch-admission receipt hashes;
- verified running/completion boundaries require a trusted verifier-source attestation in addition to a VERIFIED receipt;
- `jobStateMutationApplied: false` remains explicit so scheduler facts cannot become Job truth directly;
- `npm run verify:architecture` is now part of CI and checks permanent navigation, authority language, provider SDK isolation, public-secret naming, seed-data isolation, simulator side-effect isolation, and critical scheduler/trust bindings;
- stale `docs/ARCHITECTURE.md` wording was reconciled with implemented Phase 25 and Resource Fabric work.

Remaining drift / intentional gaps:
- implementation order remains ahead of the canonical runtime sequence: deterministic Phases 29–35/40 exist before production Phase 13/19/28 runtime integrations;
- production auth/session persistence and authoritative DB/RLS are still absent;
- live AI Gateway/OpenRouter, durable Job Engine, Pi/Linux agent, secret backend, telemetry, transactional Phase 33 store, live Phase 34 adapters/probes, billing feeds, storage/failover, second provider/DC pools, and production historical stores remain unimplemented;
- Phase 41 version registry/release manifests/manual generation is still open and is the strongest next anti-drift tranche;
- canonical PASS remains blocked wherever the master plan requires real persistence/runtime/hardware evidence.

See `docs/SOL_ARCHITECTURE_INTEGRITY_REPORT.md`.


## September 20 Phase 41 deterministic release-truth tranche

### Phase 41 — Version Registry, Release Evidence, and Operating Manuals

**STATUS: DETERMINISTIC RELEASE REGISTRY/GENERATION/VALIDATION IMPLEMENTED; PRODUCTION DEPLOYMENT EVIDENCE STILL DEPENDS ON REAL INFRASTRUCTURE**

Implemented:
- committed machine-readable `release/version-registry.json`;
- committed development/staging/production `release/environment-manifest.json`;
- app version binding to `package.json`;
- explicit database migration/schema state;
- schema/contract version labels bound to exact source paths;
- policy registry and policy-engine version binding;
- explicit AI Gateway adapter/routing-policy state;
- adapter contract/implementation status and versions;
- acceptance-evidence and manual source lists;
- per-checkout Git-SHA-bound release-manifest generation;
- exact SHA-256 source hashes for every schema/adapter/evidence/manual input;
- package-lock hash;
- GitHub Actions run/workflow/SHA evidence;
- generated human-readable operating manual;
- manifest integrity hash and generated-manual hash;
- secret-shaped release-artifact rejection;
- CI archive of verified `release/out/` artifacts;
- architecture gate now requires Phase 41 release-evidence wiring.

Important fail-closed declarations:
- no real DB/migration state is invented: database migration/schema versions are `UNIMPLEMENTED`;
- no live AI Gateway/routing version is invented: adapter is `UNIMPLEMENTED`, routing policy is `UNCONFIGURED`;
- contract-only adapters are labeled `contract-only`;
- production environment remains `productionReady: false`.

Canonical production PASS still requires real staging/production deployments, post-deploy verification, durable evidence retention appropriate to the production platform, and the remaining infrastructure acceptance from earlier phases.

See `docs/SOL_PHASE_41_REPORT.md` and `release/README.md`.

## Updated handoff boundary

Sol should continue deterministic contracts, validators, policy engines, simulators, tests, and repository hardening.

Astra/higher-compute runtime work should consume these Phase 22/23/26/27 contracts rather than rebuild them. The expensive remaining work is primarily real infrastructure integration: durable queues/workers, live AI Gateway, action/deployment adapters, real node agents, production secret/token backends, live telemetry, production reservation persistence/live dispatch concurrency, measured billing/usage feeds, storage/failover, second-provider integration, production analytics persistence, and end-to-end acceptance.


## September 20 Phase 42 deterministic voice integration

### Phase 42 — Voice Intent and Secure Handoff

**STATUS: DETERMINISTIC VOICE CONTRACTS + RELEASE-REGISTRY BINDING IMPLEMENTED; LIVE SPEECH/NATIVE-IOS RUNTIME STILL REQUIRED**

Implemented:
- versioned `VoiceIntentAdapter` and `VoiceIntentRecord` contracts;
- canonical typed intents for important-items, resource summaries/health, Raspberry Pi enrollment, resource drain, compute usage, and provider explanation;
- voice-adapter evidence records transcript SHA-256/confidence only, not raw transcript/audio;
- trusted portfolio/company/environment/resource scope is server-supplied rather than accepted from voice;
- every voice record binds the current policy-registry reference and an explicit Control API operation;
- voice permanently records `canApprove=false`, `canStepUp=false`, `canExecuteSideEffect=false`, and `canAcceptRawCredentials=false`;
- strong approvals are `secure-phone-only`; credentials are `secure-provider-or-phone-only`;
- Raspberry Pi setup hands off to the allowlisted `/resources/add` phone flow;
- resource drain may propose/initiate a workflow but cannot execute or approve it;
- exact-field and credential-shaped ingress rejection;
- resource-slot escalation rejection against trusted resource scope;
- hash-bound voice-intent integrity;
- scoped `voice.intent.accepted` audit events without raw transcript/credential data;
- Phase 41 registry now binds voice contract/adapter versions, live-adapter/provider state, environment state, CI evidence, and manuals;
- release generation/verification includes the voice source hash and fails closed on voice authority/version/environment drift;
- architecture CI prevents voice from importing approval proofs, credential broker, scheduler, or reservations directly.

Not yet claimed:
- microphone capture or live speech-to-text/text-to-speech;
- Siri/App Intent/Shortcuts/native iPhone transport;
- a real speech/NLU provider;
- production auth/session/database persistence for voice records;
- live Decisions/step-up/provider credential handoff;
- durable voice-event persistence.

See `docs/SOL_PHASE_42_REPORT.md`.



## September 20 quality + deterministic Phase 4 / 13 / 19–21 tranche

**STATUS: DETERMINISTIC CONTRACTS IMPLEMENTED; LIVE PROVIDERS/PERSISTENCE/WORKERS REMAIN REQUIRED**

Implemented:
- stable Resource Fabric public barrels with scheduler/reservation contracts and implementation moved under internal modules;
- machine-readable dependency-boundary matrix enforced by `verify:architecture`;
- dependency-free critical control-plane module/test coverage report and thresholds;
- semantic contract-version drift verification against the previous Git baseline;
- deterministic adversarial contract vector catalog;
- Phase 4 Company Integration Registry with scope/environment/read/write/credential-reference/lifecycle contracts and DEVELOPMENT-only mock adapter;
- Phase 13 provider-neutral AI Gateway roles, requirement envelope, ModelProfile, deterministic eligibility, route/fallback policy, budget/concurrency admission, kill-switch filtering, output-schema validation, audit records, and DEVELOPMENT-only mock adapter;
- Phase 19 durable Job Store/queue envelope/claim/lease/heartbeat/retry/dead-letter/cancellation/recovery contracts;
- Phase 20 business action adapter SDK + conformance contract where provider acceptance cannot mutate Job truth;
- Phase 21 software-worker/deployment pipeline contracts with CODING role, evidence requirements, staging verification, explicit production promotion receipt, rollback requirement, and non-authoritative deployment executor;
- Phase 41 release registry/environment/manifests advanced to schema 1.2.0 and now distinguish deterministic contract presence from live runtime connectivity for these systems.

Still not production-connected:
- real company OAuth/API integrations;
- OpenRouter/provider AI adapter/key/canaries/routing configuration;
- durable distributed queue/database Job Store/workers;
- real business action adapters;
- real software repository/build/staging/production/rollback execution.

See `docs/SOL_QUALITY_PHASE_4_13_19_21_REPORT.md`.
