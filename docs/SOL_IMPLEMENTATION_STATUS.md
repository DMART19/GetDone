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
