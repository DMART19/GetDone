# Sol Phase 22 / 23 / 26 / 27 Deterministic Foundation Report

This report records the bounded GPT-5.6 Sol tranche that followed the authority-hardening work. It documents deterministic repository work only and does not claim production infrastructure acceptance.

## Phase 22 — Verification, Measurement, and Outcomes

Implemented:

- first-class Verification state machine
- hash-bound VerificationRequest
- hash-bound VerificationEvidence
- hash-bound VerificationReceipt
- request/evidence/receipt expiry and freshness
- exact trusted scope and target binding
- verification strategies for execution, system, business, resource, deployment, and custom verification
- independent-source requirements
- explicit verified / failed / uncertain results
- authoritative verification transition service
- Job success/uncertain completion bound to verification receipts
- Outcome verified/uncertain/rejected completion bound to verification receipts

The verifier does not treat provider acceptance or worker claims as independent truth.

Still deferred:

- real production collectors
- durable verification persistence
- external system/business measurement integrations

## Phase 23 — Memory and Operational Learning

Implemented:

- Fact
- Lesson
- Experiment
- Observation
- OutcomeReference
- evidence, confidence, sample size, confounders, tags, expiry, and supersession
- deterministic relevance scoring
- strict portfolio/company isolation
- expired/superseded filtering
- bounded context-assembler integration

All operational memory is explicitly `authority: "advisory"`. Memory can inform future cognition but cannot directly change policy, approval, or execution authority.

Still deferred:

- durable production memory store
- retrieval indexes/embeddings if later selected
- approved policy-promotion workflow

## Phase 26 — Resource Domain and Authoritative Registry

Implemented:

- ResourceIdentityEvidence
- ResourceTrustEvidence
- ResourceHealthRecord
- ResourceCapabilityBinding
- ResourceLocation
- ResourceCostProfile
- ResourceProviderBinding
- ResourceRegistryReadModel
- authoritative Resource discovery/lifecycle service
- tenant-scoped registry reads
- deterministic READY eligibility gate

READY requires:

- verified identity
- accepted non-untrusted trust classification
- validated capabilities and adapter bindings
- fresh HEALTHY evidence and a defined health method
- authorized environment
- policy binding
- active provider/adapter binding

Provider or agent claims do not directly grant READY.

Still deferred:

- production persistence
- real enrollment/provider evidence
- scheduler authority

## Phase 27 — Generic Resource Enrollment Workflow

Implemented state sequence:

```text
IDENTIFY
  -> CREATE_ENROLLMENT
  -> OWNER_ACTION
  -> AUTHENTICATE
  -> DISCOVER
  -> PROFILE
  -> VALIDATE
  -> TEST
  -> REGISTER
  -> READY
```

Also implemented:

- trusted portfolio/company scope from the command boundary
- requested resource type/environment/adapter path
- one-time token and challenge hashes only; raw material is not persisted
- token/challenge consumption timestamps
- expiry enforcement
- replay resistance
- evidence accumulation
- cancellation
- failure
- explicit expiry
- deterministic restart with new token/challenge and incremented attempt
- lifecycle audit/idempotency through the common authoritative transition layer

Still deferred:

- Phase 28 Linux/Raspberry Pi agent
- physical canary/unplug/reconnect acceptance
- production Resource Registry persistence

## Acceptance boundary

These phases establish the deterministic contracts needed for production integration. Canonical production PASS still requires real auth/database/runtime/provider/hardware evidence where required by the master build plan.
