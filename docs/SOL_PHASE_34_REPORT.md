# Sol Phase 34 Deterministic Scheduler, Dispatch, and Start-Verification Report

This report records the GPT-5.6 Sol deterministic tranche for Phase 34. It preserves Phase 31 hard policy, Phase 32 eligibility, Phase 33 reservation/CAS semantics, Phase 22 verification authority, and JobService ownership of Job truth.

## Scheduler ranking

The deterministic scheduler consumes an authoritative Phase 32 `PlacementEvaluationReport` plus a fresh integrity-checked Phase 35 `CostGovernorReport`.

It can score only candidates already present in Phase 32 `eligibleCandidateIds` **and** Phase 35 `rankedAllowedCandidateIds`. Phase-35 approval-required/blocked candidates cannot enter autonomous scheduler ranking. An ineligible candidate cannot be selected even when manually requested.

Scheduler snapshots are bound to the exact Phase 32 candidate snapshot hash and expire independently.

Bounded preference components are:
- reliability;
- locality;
- estimated cost;
- startup latency;
- protected-capacity impact;
- owner resource preference.

Weights must be non-negative and at least one must be positive. Scoring is preference-only: it never changes Phase 31/32 hard eligibility.

## Placement decisions

A `SchedulerPlacementDecision` binds:
- Placement Request ID/hash;
- Placement Evaluation hash;
- Phase 35 Cost Governor hash;
- Scheduler Ranking hash;
- selected resource;
- selected Phase 32 candidate snapshot hash;
- selected scheduler snapshot hash;
- bounded score;
- human-readable rationale;
- decision timestamp;
- integrity hash.

Retry/fallback must create a new decision. The new record retains prior decision ID/hash and an explicit retry reason, preventing silent policy/evaluation changes from being disguised as a retry.

## Phase 33 reservation preservation

`reservationAuthorityFromDecision` converts a valid scheduler decision into the existing Phase 33 authority shape.

Phase 34 does not replace:
- CapacityLedger;
- CapacityReservation;
- AtomicReservationCommit;
- AtomicReservationStore;
- release replay semantics.

Dispatch requires:
- active/unexpired reservation;
- matching decision ID/hash;
- exact selected resource target;
- matching pending Allocation ID/hash;
- reservation hash match;
- an active Phase 29 credential lease matching Job, Placement Request, resource, company/environment, provider, and capability;
- a fresh DispatchAdmissionReceipt.

The DispatchAdmissionReceipt rechecks current policy-registry identity, current kill switches, READY/environment permission, Phase 35 governor ALLOW/freshness, Phase 33 reservation/allocation lineage, and Phase 29 credential scope/freshness. Its expiry cannot outlive any of those time-bounded authorities.

## Dispatch adapter boundary

`DispatchIntent` binds:
- placement decision;
- reservation;
- allocation;
- selected resource;
- adapter ID/version;
- idempotency key;
- issue/expiry time;
- integrity hash.

`ResourceDispatchAdapter` is the production adapter interface.

`DispatchAdapterResult` can report `accepted` or `rejected`. An accepted result requires a provider operation ID, but acceptance is not proof of execution.

## Fail-closed independent start verification

Start verification reuses the existing Phase 22 verification engine:
- subject is the allocation;
- strategy is `resource-start`;
- independent evidence is mandatory;
- `executionIndependenceKey` equals the dispatch hash.

The receipt layer still excludes evidence with the same dispatch independence key. The hardened execution boundary additionally requires a `VerificationTrustAttestation` backed by an authoritative `VerificationSourceBinding`, so a provider cannot invent a different independence string and present itself as independent. Provider ACCEPTED therefore resolves to UNCERTAIN without independent evidence.

A `VerifiedRunningPlacement` can be created only when:
- dispatch lineage is intact;
- provider dispatch was accepted;
- reservation is still active/unexpired;
- verification request is correctly bound to the dispatch/allocation;
- a fresh VERIFIED receipt contains VERIFIED `resource-start` strategy results;
- a fresh trusted-source attestation proves the evidence source is registered for that strategy/scope and belongs to a separate independence domain.

The running record explicitly carries `jobStateMutationApplied: false`. Scheduler placement truth is not Job truth.

A later deterministic bridge now converts only this independently verified running record into a hash-bound `JobVerifiedStartFact`. JobService loads that fact from its authoritative `JobExecutionBridgeStore` before allowing claimed → running. Provider ACCEPTED cannot satisfy this bridge.

## Monitor, completion, and release

A verified running placement can create a hash-bound monitoring record.

Completion verification:
- uses the allocation subject;
- requires independent `execution` verification;
- remains separate from JobService success truth;
- emits `jobStateMutationApplied: false`;
- can create a hash-bound `JobVerifiedCompletionFact` only when it matches the exact verified running-placement lineage;
- may move JobService into verification through the authoritative bridge, but final Job success still requires the existing authoritative Job verification receipt.

After verified completion, `releaseVerifiedPlacement` calls the unchanged Phase 33 `releaseReservation` function. Capacity therefore returns through the existing revision/hash/CAS commit model and exact-once replay behavior.

## Audit and explainability

Deterministic scheduler audit entries require:
- event type;
- portfolio/company/job scope;
- timestamp;
- human-readable explanation;
- related authoritative hashes;
- audit hash.

Production audit persistence is still integration work, but the records contain the lineage required to answer why a resource was selected and what happened next.

## CI-safe acceptance

Tests cover:
- only eligible candidates are ranked;
- ineligible manual selection is rejected;
- retry/fallback creates a new auditable decision;
- decision/reservation/allocation lineage is preserved through dispatch;
- expired reservations cannot dispatch;
- provider ACCEPTED alone cannot establish running;
- independent resource-start evidence can establish verified start;
- verification after reservation expiry fails closed;
- monitoring/completion do not mutate Job truth;
- verified completion releases capacity through Phase 33;
- Phase 33 exact-once release replay remains intact;
- scheduler audit records are explainable and hash-bound.

## Canonical production boundary

The deterministic Phase 34 contract and its verified JobService bridge are implemented and CI-testable.

Canonical production PASS still requires:
- a real Phase 33 transactional reservation store;
- durable placement/ranking/decision/dispatch/monitor persistence;
- live ResourceDispatchAdapter implementations;
- independent production resource-start probes;
- production completion monitoring and verification;
- durable production persistence/recovery for the now-implemented JobService verified-start/completion bridge;
- crash/restart recovery at every reserve/dispatch/verify/release boundary;
- live retry/fallback across actual resources/providers;
- durable audit persistence and end-to-end acceptance evidence.
