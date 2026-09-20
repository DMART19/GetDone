# GetDone UFO v2 — Sol Upgrade Execution Plan

## Purpose

This is the working upgrade plan for the current `DMART19/GetDone` repository. It is derived from the supplied UFO v2 screenshot, the scoped master build plan, and the actual repository state at commit `07c02f5`.

The goal is to push the repository as far as is reasonable with GPT-5.6 Sol using deterministic frontend/backend engineering, tests, schemas, state machines, and repository work, while deliberately leaving the highest-complexity autonomous-runtime, distributed-execution, and Resource Fabric work for Astra.

This plan does **not** replace the canonical 0–44 build plan. It is an execution overlay that says what Sol should complete, what requires an owner/infrastructure decision, and what should be handed to Astra.

---

## Source-of-truth order

1. Supplied UFO v2 screenshot — primary visual source of truth.
2. Canonical UFO v2 scoped build plan — primary functional/architectural source of truth.
3. Current repository — factual implementation starting point.
4. Tests and acceptance evidence — completion authority.
5. No phase is marked PASS merely because code exists.

Permanent owner navigation remains:

`Chat | Decisions | Resources`

Permanent authority rule remains:

`AI thinks -> GetDone authorizes -> workers execute -> resources supply capacity -> verification establishes truth.`

---

## Current repository baseline

At the start of this upgrade plan the repo contains:

- Next.js 15 + React 19 + TypeScript.
- iPhone-first shell and the five screenshot experiences:
  - Home / Chat
  - Resources
  - Add Resource
  - Decisions
  - Resource Detail
- Decision detail and sign-in visual shells.
- Development-only seeded resource and decision APIs.
- Typed resource/decision models.
- Provider-neutral frontend control-plane contract.
- Basic health route.
- Basic PWA manifest metadata.
- CI workflow for install, typecheck, lint, tests, and build.
- No real production authentication.
- No database/persistence layer.
- No portfolio/company tenancy.
- No authoritative approval/job/resource state.
- No production side effects.
- No AI gateway runtime.
- No durable job engine.
- No Resource Fabric enrollment/scheduler/credential broker.

This means the current code is a good Phase 1 scaffold, not yet a production control plane.

---

# SOL EXECUTION TRACK

The Sol track should run in bounded upgrade passes. Each pass gets its own commit and completion report. Continuous execution is allowed by the owner request, but each canonical phase must still pass its own acceptance gate before being represented as complete.

---

## SOL-1 — Phase 1B Screenshot Fidelity Pass

### Objective

Make the existing five primary screens visually track the supplied UFO v2 screenshot much more closely without adding backend complexity.

### Frontend work

- Create reusable visual tokens for:
  - near-black/navy backgrounds
  - electric-blue accent
  - restrained blue glow
  - card borders
  - red/yellow/green state colors
  - compact typography
  - iPhone spacing/radii
- Tune the mobile shell around real common iPhone viewport widths rather than a loose generic 480px composition.
- Preserve desktop responsiveness without turning the experience into an admin dashboard.
- Replace the layout-disrupting development banner with a small unobtrusive DEVELOPMENT indicator.

### Home / Chat

- Match header height, menu placement, GetDone wordmark, and avatar proportions.
- Tune headline size/line height/vertical placement.
- Match five action-row heights, border radius, icon treatment, badges, and spacing.
- Match composer position, attachment icon, placeholder, circular blue send button, and safe-area behavior.
- Match bottom navigation icon/label spacing and active-state glow.

### Resources

- Match title, NEW badge, subtitle, and vertical density.
- Match 2x2 metric-card proportions.
- Match Health / Total Capacity / Monthly Spend / Savings (Owned).
- Match filter sizing and selected-state treatment.
- Match resource-row height, icon block, provider/type label, health dot, and chevron.
- Match full-width + Add Resource button.

### Add Resource

- Add the screenshot-style Cancel action.
- Match category card dimensions and icon blocks.
- Match Compute / Storage / Network / Cloud Provider / Data Center / Partner / Other content.
- Match the “Not sure?” helper panel and plain-language input.
- Keep the screen navigation-free, as shown in the screenshot.

### Decisions

- Tune the seeded development counts/content to visually match the reference composition.
- Match All / High / Normal / FYI filters.
- Match left-edge severity rails.
- Match decision icon blocks, copy hierarchy, pill size, timestamps, spacing, and chevrons.
- Keep a single approval inbox.

### Resource Detail

Refactor the visual order to:

`header -> resource identity -> Actions -> tabs -> three key metrics -> metadata -> View Capabilities -> Current Workloads`

Match:
- DC West style identity block
- Healthy state
- Actions button
- Overview / Usage / Cost / Health tabs
- three metrics
- Location / Provider / Environments / Customer Data / Reliability Tier / Auto-scheduling
- capabilities row
- workload counts + utilization bar

### Files likely to change

- `app/globals.css`
- `app/page.tsx`
- `app/resources/page.tsx`
- `app/resources/add/page.tsx`
- `app/resources/[id]/page.tsx`
- `app/decisions/page.tsx`
- `components/app-header.tsx`
- `components/back-header.tsx`
- `components/bottom-nav.tsx`
- `components/brand.tsx`
- `components/chat-composer.tsx`
- `components/home-actions.tsx`
- `components/resource-*.tsx`
- `components/decision-*.tsx`
- `components/dev-badge.tsx`
- `lib/mock-data.ts`

### Acceptance

- Five screenshot experiences are recognizably the same product composition.
- No horizontal overflow at common iPhone widths.
- Chat composer stays above safe area and keyboard.
- Desktop remains centered/responsive.
- No production behavior is implied by seeded data.

---

## SOL-2 — Phase 1C UI State, Interaction, and Visual Regression Hardening

### Objective

Turn the screenshot-matched shell into a reliable frontend baseline before backend authority is introduced.

### Work

- Add route-level loading states.
- Add route-level error states.
- Add empty-state components for Decisions and Resources.
- Keep explicit offline state.
- Add skeleton cards where appropriate.
- Make all interactive rows keyboard/focus accessible.
- Improve aria labels on navigation, filters, icon buttons, and status indicators.
- Add reduced-motion handling.
- Add viewport regression tests for common iPhone widths.
- Add component tests for filters, tabs, decision actions, and composer behavior.
- Add Playwright or equivalent browser smoke tests if CI runtime supports it.
- Add a `docs/VISUAL_ACCEPTANCE.md` checklist tied directly to the screenshot.

### Acceptance

- Home, Decisions, Resources, Add Resource, and Resource Detail render correctly at narrow/mobile widths.
- Loading/error/empty/offline states cannot break navigation.
- No accidental admin-console density is introduced.

---

## SOL-3 — Control API Contract and Validation Foundation

### Objective

Prepare the frontend/backend seam so mock data can later be swapped for authoritative data without rewriting screens.

### Backend work

- Add `zod` or equivalent schema validation.
- Define GetDone-owned request/response schemas for:
  - session summary
  - portfolio/company scope
  - decisions
  - approvals
  - resources
  - capabilities
  - objectives/guardrails
  - tasks/jobs
  - audit events
- Define common API envelope:
  - correlation_id
  - success/error
  - typed error code
  - data
  - environment
- Add normalized error classes.
- Add request correlation ID middleware/helper.
- Add idempotency-key parser/helper.
- Ensure client-supplied IDs are treated only as requested identifiers, never authority.
- Keep all real mutations disabled until server authority exists.

### Frontend work

- Move pages away from importing `lib/mock-data.ts` directly.
- Read through a repository/service interface.
- Keep a clearly labeled development adapter as fallback.
- Preserve exactly the same UI while changing the data seam.

### Acceptance

- Frontend can switch between development adapter and future server adapter without component rewrites.
- Invalid API payloads fail validation.
- No route can claim a real approval/resource mutation yet.

---

## SOL-4 — Phase 2 Authentication Architecture and Secure Session Scaffold

### Objective

Build the production-shaped authentication boundary without inventing a hosting/auth provider.

### Sol can implement now

- Auth adapter interface.
- Server session types.
- Session guard helpers.
- Protected-route middleware shape.
- Logout/session-revocation contract.
- Step-up-auth contract for high-risk approvals.
- WebAuthn/passkey domain interfaces.
- Security tests proving:
  - deep link != authority
  - missing session blocks protected server actions
  - step-up state is independent from normal login
- Environment-variable schema with no secrets committed.

### Owner/infrastructure checkpoint

A real Phase 2 PASS requires choosing/provisioning the production auth/session implementation. The repository currently has no factual auth provider, so Sol should not silently invent one.

Recommended implementation shape:
- Postgres-compatible authoritative data store.
- Auth provider behind the GetDone auth adapter.
- If Supabase is chosen, keep Supabase-specific code inside infrastructure adapters rather than domain/business logic.

### Acceptance before provider connection

Mark as `OWNER ACTION REQUIRED`, not PASS, until real session creation/refresh/revocation is connected and verified.

---

## SOL-5 — Phase 3 Persistence, Portfolio/Company Scope, and Tenant Authorization

### Objective

Create the server-authoritative data hierarchy once a database target is available.

### Schema

Implement migration-ready entities for:

- users
- portfolios
- portfolio_memberships
- companies
- company_memberships
- resources (future-safe shell only)
- resource_pools (future-safe shell only)
- credential_bindings (reference metadata only)
- resource_policy_bindings (reference metadata only)

### Authorization

- Resolve user -> portfolio -> company server-side.
- Never trust company_id/resource_id authority from browser payloads.
- Add repository/data-access helpers that always require trusted scope.
- Add cross-tenant denial tests.
- Add deep-link authorization tests.
- Add membership-revocation tests.

### If Supabase/Postgres RLS is selected

- Add RLS policies/migrations.
- Add automated cross-tenant RLS tests.
- Keep service-role credentials server-only.

### Acceptance

- User A cannot read or mutate User B scope.
- Client ID tampering fails.
- Revoked membership removes authority.

---

## SOL-6 — Phases 5–8 Deterministic Authority Foundation

This is the largest backend block Sol should complete before handing model-driven execution to Astra.

### Phase 5 — Capability Registry

Implement typed definitions for examples such as:

- `revenue.read`
- `email.send`
- `repository.inspect`
- `production.deploy`
- `compute.cpu.light`
- `compute.gpu.inference`
- `storage.backup`
- `resource.health.read`

Each capability records:

- scope
- adapter binding
- read/write class
- sensitivity
- production effect
- reversibility
- risk
- cost model
- blast radius
- approval requirement
- rate limit
- typed input/output schemas
- enabled state

Unknown/disabled capabilities fail closed.

### Phase 6 — Objectives / Guardrails / Budgets

Implement:
- objectives
- measurable targets
- priorities
- deadlines
- budgets
- guardrails
- protected metrics
- pause/resume state

Keep objectives separate from guardrails. No AI can silently edit them.

### Phase 7 — Deterministic State Machines

Implement server-authoritative state models/services for:

- Goal
- Plan
- Decision
- Approval
- Task
- Job
- Event
- Outcome
- Audit

Predefine future resource entities without implementing scheduling:

- Resource
- ResourcePool
- PlacementRequest
- PlacementDecision
- Reservation
- Allocation
- Failover
- ResourceIncident

Add explicit allowed transition maps and rejection for illegal transitions.

### Phase 8 — Audit + Idempotency

Implement:
- append-only audit/event records
- correlation IDs
- actor identity
- provenance
- environment/scope
- idempotency keys
- timeout/retry metadata
- callback signature helpers
- deterministic duplicate-request behavior

### Acceptance

- Browser cannot mark a job/resource successful.
- Invalid transitions fail server-side.
- Duplicate logical requests do not bypass authority.
- Audit can reconstruct consequential transitions.
- No unrestricted `execute_anything` / `call_any_api` escape hatch exists.

---

## SOL-7 — Phases 9–12 Deterministic Intelligence Substrate

### Objective

Build the non-LLM sensing/context foundation so Astra later connects cognition to a stable substrate instead of inventing it.

### Phase 9 — Signal Bus

Implement:
- raw event schema
- normalization
- deduplication
- trusted scope resolution
- provenance
- normalized signals
- business and future resource signal vocabulary

Do not call AI per event.

### Phase 10 — Sensing Engine

Implement deterministic classifications:
- informational
- expected
- threshold
- anomaly
- trend
- opportunity
- risk
- goal drift
- incident

Allowed outputs:
- IGNORE
- RECORD
- MONITOR
- INVESTIGATE
- ESCALATE

Add thresholds, freshness, cooldown, and dedupe logic.

### Phase 11 — External Intelligence Record Model

Sol should implement:
- mission definitions
- source/reference fields
- retrieved_at
- scope relevance
- freshness
- confidence
- provenance
- cost/rate-limit configuration

Do **not** build autonomous browsing/research orchestration unless a real runtime/provider is selected.

### Phase 12 — Context Assembler

Implement deterministic bounded context assembly for:
- company
- portfolio
- facts
- signals
- outcomes
- decisions
- policies
- capabilities
- future resource summaries

Enforce scope and provenance.

### Acceptance

- Duplicate/out-of-order events are safe.
- Normal fluctuations do not create expensive reasoning.
- Cross-company context leakage tests fail closed.
- Context is bounded and provenance-aware.

---

## SOL-8 — Frontend <-> Authoritative Backend Integration

### Objective

Replace the development-only illusion with real read models as backend phases become available.

### Work

- Decisions page reads authoritative scoped decisions.
- Decision Detail reads authoritative decision state.
- Approve/Modify/Reject buttons call controlled server endpoints only after Phase 7/8 authority exists.
- Resources page reads authoritative resource-shell records only when registry data is real.
- Development seed adapter remains available only in DEVELOPMENT.
- Add explicit loading/error/offline reconciliation.
- Never let frontend optimistic state become execution truth.

### Acceptance

- Refresh/reconnect always resolves to server truth.
- Failed mutations roll back local presentation.
- Development seed data is impossible to mistake for production state.

---

## SOL-9 — CI, Security, and Repository Hardening

### Work

- Lock runtime/package-manager version.
- Generate and commit lockfile.
- Add dependency audit step where practical.
- Add secret-pattern scan.
- Add test categories:
  - unit
  - API contract
  - state machine
  - idempotency
  - tenant isolation
  - frontend smoke
- Add branch-safe CI.
- Add environment-schema validation.
- Add production build check.
- Add coverage for security-critical deterministic modules.
- Add docs for:
  - architecture
  - auth boundary
  - tenancy
  - capability registry
  - state machines
  - audit/idempotency
  - signal bus
  - context assembler

### Acceptance

A change cannot be represented as complete if build/typecheck/tests fail.

---

# OWNER ACTION CHECKPOINTS

Sol should stop only when a real external decision/secret is unavoidable.

Likely owner actions:

1. Choose/provision production database.
2. Choose/provision production authentication/session provider.
3. Supply environment-specific secrets through the deployment platform, never chat/repo.
4. Choose deployment/worker/queue infrastructure before durable cloud jobs.
5. Later provide OpenRouter credential through the secure server-side setup flow.
6. Later authorize real provider/resource credentials and physical Raspberry Pi enrollment.

Until those exist, corresponding canonical phases remain `OWNER ACTION REQUIRED` rather than falsely PASS.

---

# ASTRA HANDOFF TRACK

The following work should be preserved for Astra or another higher-compute coding agent after the Sol foundation is stable.

## ASTRA-A — Phase 13 Interchangeable AI Gateway

Astra should own the production implementation of:

- OpenRouter server-side adapter
- model-role routing
- capability/vision/tool/structured-output eligibility
- safe fallback chains
- canary validation
- budgets/rate limits/concurrency
- model/provider kill switches
- usage/cost audit
- malformed-output handling
- alternate-gateway seam

Sol may prepare interfaces/schemas but should not pretend this runtime is complete.

## ASTRA-B — Phases 14–18 Planning, Validation, Authorization, Task/DAG

Astra should integrate:

- model-generated plan construction through the gateway
- deterministic plan validator
- production policy/preflight
- strong approvals
- autonomous task generation
- executable DAG compilation

The deterministic contracts can be prepared by Sol; live model-driven behavior waits for the real gateway.

## ASTRA-C — Phases 19–23 Durable Execution and Learning

Reserve for Astra:

- persistent distributed queue
- leases/heartbeats
- crash recovery
- retries/dead-letter
- scheduled execution
- business action adapters
- software worker/deployment pipeline
- independent verification
- outcomes
- operational memory/learning

This is where long-running cloud behavior and difficult failure semantics begin.

## ASTRA-D — Phases 26–31 Core Resource Fabric

Reserve for Astra:

- authoritative resource registry implementation at production scale
- enrollment workflow
- Raspberry Pi/Linux ARM64 agent
- cryptographic resource identity
- credential broker
- resource profiling
- authenticated telemetry
- data/resource policy

Sol can keep the UI and domain contracts ready for these systems.

## ASTRA-E — Phases 32–40 Placement, Scheduling, Economics, Storage, Resilience

Reserve for Astra:

- candidate evaluation
- atomic reservations
- capacity ledger
- scheduler/dispatch/start verification
- cost/capacity governor
- storage fabric/data placement
- failure domains
- drain/circuit breaker/failover
- resource adapter SDK
- partner/data-center pools
- zero-side-effect policy simulator

These are high-complexity distributed-system areas where broad reasoning and adversarial review are especially valuable.

## ASTRA-F — Phases 41–44 Release / Companion / Final Adversarial Gate

Astra can finish:

- version registry/release evidence
- generated operating manuals
- voice handoff
- optional Apple Watch companion
- final adversarial acceptance suite
- phone-off/background-runtime tests
- end-to-end release gate

---

# Handoff condition from Sol to Astra

Astra should not receive a half-formed mock app. The preferred handoff state is:

- Screenshot-fidelity frontend is stable.
- UI states and mobile layout are tested.
- Frontend uses provider-neutral service interfaces.
- Auth/session boundary exists and is connected if owner infrastructure is available.
- Portfolio/company authorization exists and is tested.
- Capability registry exists.
- Objectives/guardrails/budgets exist.
- Deterministic state machines exist.
- Audit/idempotency foundation exists.
- Signal bus and deterministic sensing exist.
- Context assembler exists.
- CI/build/test gates are green.
- No production secret is in the repo.
- No AI/provider/browser is authoritative.
- No fake Resource Fabric behavior is represented as real.

At that point Astra can spend its higher-compute budget on the systems that actually benefit from it instead of recreating UI, types, validation, and deterministic foundations.

---

# Commit sequence

Recommended commit order:

1. `Phase 1B: match UFO v2 screenshot fidelity`
2. `Phase 1C: harden UI states and mobile tests`
3. `Control API: add typed schemas and validation boundary`
4. `Phase 2: add auth/session adapter foundation`
5. `Phase 3: add portfolio/company scope and persistence`
6. `Phases 5-6: add capability registry and guardrails`
7. `Phases 7-8: add state machines audit and idempotency`
8. `Phases 9-10: add signal bus and sensing engine`
9. `Phases 11-12: add intelligence records and context assembler`
10. `Integrate authoritative read models into owner UI`
11. `Harden CI security and Astra handoff`

Each commit should preserve working UI and update a phase report.

---

# Stop rules

Sol must stop and mark the applicable work `OWNER ACTION REQUIRED` or `ASTRA HANDOFF` when:

- a real secret/credential is required;
- a production infrastructure choice has not been made;
- a phase requires long-running distributed runtime behavior not available for verification;
- real hardware/provider enrollment is required;
- an AI gateway needs production canary/fallback testing;
- a scheduler/credential broker/failover system cannot be safely validated end-to-end;
- a change would weaken the authority model merely to make a demo appear functional.

No mock or local preview may be described as production autonomy.

---

# Expected result before Astra

The Sol-upgraded repository should look much closer to the supplied UFO v2 screenshot **and** have a substantially stronger backend foundation:

`Screenshot-grade owner UI -> typed Control API -> auth/scope -> capability/policy -> deterministic state -> audit/idempotency -> signals/context`

Astra then continues from:

`AI Gateway -> planning/authorization -> durable jobs -> real adapters -> verification -> Resource Fabric -> scheduler/economics/resilience -> release gate`

This keeps higher-compute work focused where it adds the most value while avoiding a future rewrite of the frontend or deterministic control-plane foundation.
