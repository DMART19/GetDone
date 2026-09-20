# Sol Upgrade Implementation Status

This file tracks code actually implemented from `SOL_UPGRADE_EXECUTION_PLAN.md`. It does not replace canonical phase reports.

## Implemented in code

### SOL-1 — Phase 1B screenshot fidelity
- Added dedicated UFO v2 fidelity stylesheet.
- Tightened the owner shell around iPhone-sized composition.
- Made the DEV marker non-layout-disruptive.
- Added Add Resource Cancel action.
- Reordered Resource Detail to tabs -> metrics -> metadata -> capabilities -> workloads.
- Expanded screenshot-style seeded Decisions data.

### SOL-2 — Phase 1C UI state hardening
- Added loading, error, not-found, reduced-motion, focus-visible, and skeleton states.
- Added `docs/VISUAL_ACCEPTANCE.md`.

### SOL-3 — Control API foundation
- Added typed control-plane errors.
- Added request correlation/environment/idempotency helpers.
- Added runtime parsing for decision-action requests and typed API envelopes.
- Added a provider-neutral owner read-repository seam.
- Owner pages now read through the repository seam instead of importing seed arrays directly.
- Development seed data is blocked when `NEXT_PUBLIC_APP_ENV=production` and `GETDONE_DATA_MODE=development-seed`.

### SOL-4 — Authentication architecture scaffold
- Added AuthAdapter, AuthSession, StepUpChallenge, passkey descriptor, and session authority helpers.
- Added tests for expiration/revocation and independent fresh step-up.
- Real provider/session persistence is not connected.

### SOL-6 — Deterministic authority foundation
- Added typed capability registry with fail-closed lookup.
- Added objective/guardrail domain types and deterministic conflict detection.
- Added explicit state-transition maps for goal/plan/decision/approval/task/job/resource/reservation.
- Added immutable transition records carrying actor/scope/event metadata.
- Added audit-event contract.
- Added idempotency store contract, in-memory test implementation, duplicate handling, and conflict handling.

### SOL-7 — Deterministic intelligence substrate
- Added normalized signal model, dedupe key, deterministic attention classification, and deduplication.
- Added bounded scoped context assembly with portfolio/company/sensitivity filtering.
- Added tests for dedupe/escalation and cross-company context isolation.

## Verification state

Automated tests were added for:
- control API parsing
- session authority
- state transitions
- idempotency
- deterministic signals
- context scope

GitHub CI/build evidence is still required before any canonical phase is marked PASS.

## Owner action still required

Canonical Phase 2 cannot PASS until a production auth/session implementation is chosen and connected.

Canonical Phase 3 cannot PASS until an authoritative database/persistence target is chosen and migrations/RLS/tenant tests run against it.

No production secrets should be committed to this repository.

## Astra handoff still deferred

No production AI gateway, durable distributed job engine, real resource enrollment/agent, credential broker, scheduler, reservations/capacity ledger, provider failover, or production Resource Fabric behavior has been claimed or implemented here.
