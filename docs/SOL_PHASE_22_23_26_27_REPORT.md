# Sol Phase 22 / 23 / 26 / 27 Deterministic Implementation Report

## Scope

This report records the deterministic implementation tranche added after the authority-hardening work on September 20, 2026. It deliberately separates code-level completion from canonical production acceptance.

## Phase 22 — Verification, Measurement, and Outcomes

**Deterministic status: IMPLEMENTED**

Added:
- immutable hash-bound VerificationRequest
- immutable hash-bound VerificationEvidence
- strategy-specific verification results
- immutable hash-bound VerificationReceipt
- evidence freshness and expiry
- request/receipt expiry
- independent-verifier domains
- pass / fail / unknown evidence
- verified / failed / uncertain verdicts
- authoritative Verification transitions
- Task / Job / Outcome receipt binding

A bare provider success, HTTP 200, worker claim, or arbitrary evidence ID is not sufficient to establish authoritative success.

Still required for canonical production acceptance:
- durable database persistence
- real verifier adapters
- real business KPI sources
- real resource-start/release/cost reconciliation

## Phase 23 — Memory and Operational Learning

**Deterministic status: IMPLEMENTED**

Added advisory scoped records:
- Fact
- Lesson
- Experiment
- Observation
- OutcomeReference

Every record can carry:
- confidence
- sample size
- confounders
- evidence IDs
- sensitivity
- relevance tags
- observed time
- expiry
- supersession
- integrity hash

Selection:
- strict portfolio/company filtering
- active/expiry filtering
- superseded-record removal
- deterministic relevance score
- bounded result count

Context:
- operational memory maps into a dedicated bounded Context Assembler section
- memory provenance includes the integrity hash
- memory remains `authority: advisory`
- no memory record can directly mutate policy, approval, authorization, or placement truth

## Phase 26 — Resource Domain and Authoritative Registry

**Deterministic status: IMPLEMENTED**

Expanded the Resource domain with:
- identity evidence
- trust evidence
- health records
- capability bindings
- locations/failure domains
- cost profiles
- provider/adapter bindings
- registry evidence snapshots
- readiness evaluation
- concise owner read models
- authoritative registry lifecycle service

READY requires deterministic evidence for:
1. verified resource identity
2. non-untrusted verified trust classification
3. fresh healthy status
4. validation of every declared capability
5. verified location
6. environment permission
7. policy binding
8. active authenticated provider/adapter binding

Provider or agent self-report alone cannot satisfy those requirements.

## Phase 27 — Generic Resource Enrollment

**Deterministic status: IMPLEMENTED**

Lifecycle:

```text
IDENTIFY
  -> CREATE_ENROLLMENT
  -> OWNER_ACTION (when required)
  -> AUTHENTICATE
  -> DISCOVER
  -> PROFILE
  -> VALIDATE
  -> TEST
  -> REGISTER
  -> READY
```

Added:
- one-time challenge hash storage
- raw challenge excluded from persisted enrollment record
- expiration
- replay prevention
- owner-action evidence
- stage evidence
- cancellation
- expiry
- failure
- deterministic restart
- new challenge on restart
- incremented attempt number
- authoritative scope and audit transitions

Canonical production acceptance remains blocked on real resource/provider integration, real persistence, and the Phase 28 Linux/Raspberry Pi agent vertical slice.

## CI acceptance

**DETERMINISTIC REPOSITORY GATE: PASS**

GitHub Actions run **#61** on code head `6b8a39ab3f255fb4b5037dd4440bbd6e180ba818` completed successfully on September 20, 2026.

Verified:
- `npm ci`
- Node 24 / npm 11.19 runtime verification
- secret-pattern scan
- TypeScript typecheck
- ESLint
- Vitest: **38 test files passed / 176 tests passed**
- Next.js production build

This proves the deterministic repository tranche is internally green. It does **not** convert the infrastructure-dependent portions of canonical Phases 22, 26, or 27 into production PASS; real persistence, verifier sources, provider/device flows, telemetry, and hardware/runtime acceptance remain required where the master plan specifies them.
