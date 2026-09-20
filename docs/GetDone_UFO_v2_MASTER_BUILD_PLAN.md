GETDONE — UFO v2
MASTER BUILD PLAN
Production + Mobile + Governed Autonomy + Interchangeable AI Gateway + Resource Fabric Edition
Canonical consolidation of the supplied ChatGPT-scoped and OpenRouter multi-model plans

MASTER STATUS
-------------
This document supersedes the two supplied GetDone UFO v2 build plans as the canonical implementation plan.

The merge rule is:
- Preserve the original governed-autonomy and Resource Fabric authority model.
- Adopt the newer provider-neutral AI Gateway architecture.
- Use OpenRouter as the default runtime multi-model gateway, but never as a business-logic dependency.
- Keep model families interchangeable behind GetDone-owned contracts.
- Preserve the screenshot-simple owner experience: Chat | Decisions | Resources.
- Preserve the full 0–44 phased build order and evidence-based release gate.
- When this plan and the live repository differ, inspect the repository, document the migration impact, and change safely rather than assuming either side is already implemented.

LOCKED ARCHITECTURAL DECISIONS
------------------------------
1. AI is cognition, not authority.
2. GetDone owns authentication, scope, policy, approvals, job state, resource trust, placement authority, credential scope, verification truth, audit truth, and kill switches.
3. Workers and adapters execute only typed, authorized capabilities.
4. Resources provide capacity; they never become authority merely because they are powerful, local, cheap, or provider-managed.
5. OpenRouter is the default AI gateway adapter. Feature code calls the GetDone AI Gateway, not OpenRouter or a model SDK directly.
6. Models are selected by validated capability and policy through role classes such as LIGHTWEIGHT, STANDARD, HIGH_REASONING, CODING, VISION, and LONG_CONTEXT. DETERMINISTIC means no model call.
7. Persistent server/cloud infrastructure owns background schedules, queues, jobs, sensing, placement, health, failover, verification, measurement, and notifications.
8. The frontend is a control surface, not the execution engine.
9. One Decisions queue handles business and resource approvals.
10. The permanent owner navigation remains exactly Chat | Decisions | Resources.
11. DEVELOPMENT, STAGING, and PRODUCTION remain isolated in credentials, policies, queues, webhooks, databases/bindings, and deployment rights as appropriate.
12. No raw production secret is stored in the frontend, browser storage, normal logs, model prompts, resource metadata, or operating manuals.
13. Every meaningful side effect is scoped, typed, policy-checked, authorized, idempotent where applicable, auditable, failure-aware, and verified.
14. Provider/model/resource claims are untrusted until independently validated.
15. A phase is not complete because code exists; it is complete only when its acceptance evidence passes.

CANONICAL SYSTEM SHAPE
----------------------
OWNER SURFACES
  iPhone/PWA
  Chat
  Decisions
  Resources
  Voice / Watch companion when enabled
        |
        v
GETDONE CONTROL API
  Auth / Sessions
  Portfolio + Company Scope
  Capability Registry
  Objectives + Guardrails
  Policy + Preflight
  Decisions + Approvals
  Audit + Kill Switches
        |
        +-------------------------------+
        |                               |
        v                               v
INTELLIGENCE PLANE                EXECUTION PLANE
  Signal Bus                       Task Compiler / DAG
  Sensing Engine                   Durable Job Engine
  External Research                Business Adapters
  Context Assembler                Software Worker
  GetDone AI Gateway               n8n / APIs / Webhooks / MCP
     -> OpenRouter default
     -> interchangeable models
        |                               |
        +---------------+---------------+
                        v
                 VERIFICATION / OUTCOMES
                 Measurement / Memory
                        |
                        v
                RESOURCE CONTROL PLANE
                  Resource Registry
                  Enrollment
                  Credential Broker
                  Profiling / Telemetry
                  Resource Policy
                  Placement
                  Reservations
                  Scheduler
                  Cost Governor
                  Storage Fabric
                  Resilience / Failover
                  Provider Adapters
                        |
        +---------------+----------------------+
        |               |          |           |
        v               v          v           v
   Raspberry Pi      Home NAS     Cloud     Partner / DC Pools

BUILD STRATEGY
--------------
Build vertical slices, not a giant distributed system all at once.

First prove:
Owner intent -> scoped plan -> deterministic authorization -> durable job -> real adapter execution -> independent verification -> outcome.

Then prove:
Add one real Raspberry Pi -> enroll -> identify -> profile -> validate -> policy -> eligible placement -> execute canary -> verify -> unplug -> safe failure -> recover.

Only after those slices work should GetDone broaden to Home NAS, additional providers, partner/data-center pools, economic optimization, resilience orchestration, simulation, voice, and Watch.


PURPOSE
-------
This document merges the v1 governed autonomous execution architecture with the UFO v2 Resource Fabric, an interchangeable multi-model AI gateway, and the supplied front-end screenshot into one implementation plan designed for a repository-aware coding agent such as ChatGPT/Astra, Codex, Claude Code, OpenCode, or an equivalent agent to execute one bounded phase at a time. GetDone runtime cognition is provider-neutral and must not depend on any single model family or coding agent.

THIS IS AN EXTENSION, NOT A REDESIGN
------------------------------------
The owner-facing product remains intentionally simple. The backend becomes much more capable, but the normal user should not experience a proportional increase in complexity.

SOURCE-OF-TRUTH ORDER
---------------------
1. The supplied UFO v2 screenshot is the PRIMARY VISUAL source of truth.
2. This build plan is the PRIMARY FUNCTIONAL/ARCHITECTURAL execution plan.
3. The actual repository, migrations, infrastructure, provider configuration, and deployed environments are the factual implementation starting point.
4. Automated tests and acceptance evidence determine whether a phase passes.
5. When old v1 UI behavior conflicts with the screenshot, the screenshot wins.
6. When current code conflicts with the architecture, do not silently preserve old behavior. Identify the conflict, assess migration impact, and implement safely.
7. Runtime AI cognition must remain behind the GetDone AI Gateway contract. OpenRouter is the default gateway implementation, not a business-logic dependency.

OWNER EXPERIENCE
----------------
External experience:
ASK
→ REVIEW
→ APPROVE WHEN REQUIRED
→ DONE

Resource experience:
ADD
→ AUTHORIZE MINIMUM REQUIRED ACCESS
→ GETDONE DISCOVERS / TESTS / CLASSIFIES
→ READY

Internal loop:
OBJECTIVE
→ SENSE
→ DETECT
→ INVESTIGATE
→ UNDERSTAND
→ PLAN
→ VALIDATE
→ AUTHORIZE
→ COMPILE
→ SELECT ELIGIBLE RESOURCES
→ RESERVE
→ EXECUTE
→ VERIFY
→ MEASURE
→ REMEMBER
→ RELEASE RESOURCES
→ REPEAT

CORE AUTHORITY MODEL
--------------------
AI THINKS.
GETDONE AUTHORIZES.
WORKERS EXECUTE.
RESOURCES SUPPLY CAPACITY.
THE RESOURCE CONTROL PLANE CHOOSES ELIGIBLE PLACEMENT.
VERIFICATION ESTABLISHES TRUTH.
AUTHORITATIVE DATA SERVICES STORE CONTROL STATE AND MEMORY.
RESOURCES ARE CAPACITY, NOT AUTHORITY.

AI GATEWAY PRINCIPLE
--------------------
GETDONE OWNS THE COGNITIVE CONTRACT. OPENROUTER IS THE DEFAULT MODEL GATEWAY. MODELS ARE REPLACEABLE COGNITIVE RESOURCES, NOT AUTHORITIES.

Default runtime path:
GETDONE CONTROL PLANE
→ GETDONE AI ROUTER
→ OPENROUTER GATEWAY
→ ELIGIBLE MODEL / PROVIDER
→ STRUCTURED RESPONSE VALIDATION
→ GETDONE POLICY / AUTHORITY

Rules:
- Use one environment-scoped OpenRouter API credential as the normal owner setup path for multi-model access.
- Never hard-code business logic to OpenAI, Anthropic, Google, Astra, Codex, Claude, Gemini, or any single model family.
- GetDone routes by required capability and policy, not by brand name embedded in task logic.
- Model role classes are configuration, not authority: LIGHTWEIGHT, STANDARD, HIGH_REASONING, CODING, VISION, and LONG_CONTEXT. DETERMINISTIC means no model call.
- Each model profile records supported modalities/tools, structured-output compatibility, context limits, cost/latency metadata, provider/gateway identity, allowed data classes, environment eligibility, health, and validation status.
- A task first declares AI requirements. The router filters to eligible models, then applies owner routing policy, cost/latency preferences, and approved fallbacks.
- OpenRouter model/provider fallback may be used only inside an allow-listed eligible route. A fallback may not weaken required capabilities, data policy, environment restrictions, or security rules.
- Record the requested route, actual returned model/provider when available, latency, token/cost usage, validation result, fallback reason, and correlation ID for auditability.
- Model output is untrusted input until schema validation and deterministic policy checks pass.
- AI gateway failure degrades intelligence gracefully; it must never corrupt authoritative state or halt already-authorized deterministic execution that does not require a fresh model call.
- Keep an internal AI-gateway adapter boundary so OpenRouter can later be replaced or supplemented without rewriting GetDone business logic.

AI MUST NEVER BE AUTHORITATIVE FOR
----------------------------------
- authentication
- portfolio/company/resource scope
- permissions
- approvals
- policy
- data classification authority
- financial authorization
- production authorization
- credential access or credential scope
- resource trust state
- job state
- allocation truth
- audit integrity
- execution truth
- verification truth
- kill-switch state

BACKGROUND EXECUTION RULE
-------------------------
No important autonomous or resource workflow may depend on:
- an open browser tab
- an active phone/watch
- a frontend timer
- a developer laptop
- a manually running temporary local process
- a temporary AI/model session

Persistent server/cloud infrastructure owns schedules, sensing, investigations, queues, jobs, placement, reservations, resource health, resilience actions, verification, measurement, notifications, and outcome processing.

ENVIRONMENTS
------------
Support DEVELOPMENT, STAGING, and PRODUCTION with separate credentials, bindings, queues, webhooks, databases, deployment rights, notifications, and policies as appropriate. Staging must never silently consume production credentials or production-only resource bindings.

SECRETS
-------
Raw production secrets never live in browser storage, frontend bundles, logs, model prompts unless explicitly required and safely scoped, resource metadata, operating manuals, or the Resource Registry. Use secret references, credential bindings, scoped leases, short-lived tokens where possible, rotation, revocation, and auditable access. OpenRouter credentials are server-side secrets. Use separate environment-scoped keys or bindings for DEVELOPMENT, STAGING, and PRODUCTION where appropriate. The UI may accept a key only through a secure write-only setup flow; after storage it shows connection status, not the raw key.

SIDE-EFFECT CONTRACT
--------------------
Every meaningful side effect requires:
- authenticated scope
- known typed capability
- policy evaluation
- authorization
- idempotency
- timeout
- retry behavior
- explicit failure state
- auditability
- cancellation where appropriate
- verification
- resource placement verification when resource-backed

Never create unrestricted escape hatches such as execute_anything, call_any_api, run_arbitrary_command, use_any_resource, bypass_policy, or force_success.

FAILURE PHILOSOPHY
------------------
FAIL CLOSED FOR AUTHORITY.
FAIL GRACEFULLY FOR INTELLIGENCE.
FAIL OVER SAFELY FOR ELIGIBLE EXECUTION.
NEVER CLAIM RECOVERY WITHOUT VERIFICATION.

UFO v2 FRONT-END CONTRACT
-------------------------
Permanent bottom navigation:
CHAT | DECISIONS | RESOURCES

HOME / CHAT
- Preserve the conversational start screen.
- Keep "Show me what's important."
- Keep "Work on growth."
- Add/retain "Check my resources."
- Keep "Check my decisions."
- Keep "Tell me / Ask anything."
- Keep the compact message composer.
- Resources should feel like one more executive capability, not a cloud console.

RESOURCES OVERVIEW
- Header: Resources
- Subtitle: "All your compute, storage and infrastructure in one place."
- Summary cards: Health, Total Capacity, Monthly Spend, Savings (Owned)
- Filters: All, Compute, Storage, Network
- Rows show only display name, short type/role, health, and optional provider icon.
- Primary action: + Add Resource
- Do not expose pods, raw process lists, shell access, node topology, or deep telemetry on this screen.

ADD RESOURCE
- Compute — server, GPU, Raspberry Pi, VM, cluster, data center
- Storage — NAS, cloud storage, backup, archive
- Network — VPN, gateway, private link
- Cloud Provider — AWS, Google Cloud, Azure, other supported providers
- Data Center / Partner — partner cluster, colo, managed pool
- Other — custom resource type
- Plain language path: "Not sure? Just describe it in plain language. I'll figure it out."
- Manual category selection and Chat must converge on the same enrollment workflow.

DECISIONS
- Keep one approval inbox.
- Resource approvals appear in the existing queue.
- Preserve High / Normal / FYI treatment.
- Approve / Modify / Reject remain the normal interaction.
- Strong approvals require configured step-up authentication.

RESOURCE DETAIL
- Resource name, health state, resource type/provider class
- Actions menu
- Tabs: Overview / Usage / Cost / Health
- Three resource-appropriate key metrics
- Location
- Provider
- Environments
- Customer-data policy
- Reliability tier
- Auto-scheduling
- View Capabilities
- Current Workloads
- Advanced node/GPU/VRAM/CPU/RAM/queue/network/credential/failure-domain/history data is on demand only.

AI GATEWAY SETTINGS — SECONDARY / ADVANCED, NOT BOTTOM NAV
- Default gateway: OpenRouter.
- Primary setup path: paste one OpenRouter API key into a secure write-only field, verify server-side, store only as a secret reference/binding, and return Connected / Error status.
- Never return the raw API key to the browser after save.
- Normal owner view shows gateway health, current routing profile, monthly AI spend/usage summary if available, and fallback status.
- Advanced view may map LIGHTWEIGHT, STANDARD, HIGH_REASONING, CODING, VISION, and LONG_CONTEXT roles to ordered eligible model routes.
- Support Auto/Balanced owner policy only as a routing preference layer; hard capability, data, environment, and security constraints always filter first.
- The owner can disable a model, provider, or route without changing application code.
- Keep exact model slugs/configuration out of ordinary business-task logic.

CODING-AGENT EXECUTION PROTOCOL
-------------------------------
Run ONE numbered phase at a time unless the owner explicitly asks for continuous execution.

Before editing:
1. Read this plan.
2. Inspect the current repository and the previous phase completion report.
3. Re-state the current phase objective and files/services expected to change.
4. Do not implement future phases "while you are here."
5. Preserve working functionality unless the phase explicitly replaces it.
6. Prefer deterministic code/tests/scripts/APIs/CLI over model reasoning for repetitive work.
7. If a required owner-only action is unavoidable, stop only at that action.

OWNER-ACTION FORMAT
-------------------
STATUS: OWNER ACTION REQUIRED
WHAT:
WHY:
MINIMUM OWNER ACTION:
SECURITY CONSIDERATIONS:
HOW THE CODING AGENT WILL VERIFY:
WHAT CONTINUES AFTERWARD:

UNIVERSAL PHASE COMPLETION GATE
-------------------------------
Before any phase is PASS:
1. Build/compile succeeds or a pre-existing failure is explicitly documented.
2. Database migrations apply successfully when present.
3. Existing tests pass.
4. New phase tests pass.
5. RLS/tenant/resource-scope tests pass where applicable.
6. Existing UI flows remain functional.
7. Mobile layout remains functional.
8. No secrets appear in client bundles or inappropriate logs.
9. Mock providers are never represented as real.
10. Current phase acceptance criteria pass.
11. No important background workflow depends on frontend presence.
12. Environment boundaries remain intact.
13. AI has not been granted production authority.
14. New side effects are idempotent where applicable.
15. Authoritative state transitions remain server-side.
16. Frontend/model/provider-supplied IDs are never trusted as authority.
17. New resource changes do not weaken portfolio/company isolation.
18. No future phase is falsely marked complete.
19. Telemetry does not create unbounded expensive model calls.
20. Provider/resource callbacks are authenticated and independently verified.
21. Model-backed features call the GetDone AI Gateway abstraction rather than provider-specific SDKs from feature code.
22. Model fallback cannot weaken required capabilities, data policy, environment isolation, security, or authority rules.
23. AI gateway credentials are server-side, environment-scoped, and absent from client bundles/prompts/logs/manuals.
24. Actual model/provider/fallback and model-call usage are captured for audit where available.

REQUIRED PHASE REPORT
---------------------
PHASE:
STATUS: PASS / OWNER ACTION REQUIRED / BLOCKED

IMPLEMENTED:
MIGRATIONS:
TESTS:
SECURITY CHECKS:
MOBILE CHECKS:
RESOURCE CHECKS:
AI GATEWAY CHECKS:
ENVIRONMENT VARIABLES:
INFRASTRUCTURE:
OWNER ACTIONS:
DEFERRED:
BLOCKERS:
NEXT PHASE READY: YES / NO

Do not start the next phase automatically unless explicitly authorized.

BOOTSTRAP READINESS — BEFORE PHASE 0
------------------------------------
Bootstrap is not a feature phase.

Inspect:
- repository/default branch/runtime/package manager
- build/lint/typecheck/tests
- current UI and supplied screenshot
- database/auth/migrations/RLS
- source control and protected-branch workflow
- hosting for frontend/control API/workers/queues/schedules
- AI gateway configuration, OpenRouter server-side credential path, model-role routing configuration, fallback policy, and safe provider abstraction
- PWA/passkey/push prerequisites
- CI/CD, logs, monitoring, backups, restore path
- existing compute/storage/network/provider assumptions
- one initial business vertical slice
- one initial resource vertical slice (prefer Raspberry Pi; may be deferred to Phase 28 if hardware is unavailable)

Bootstrap PASS means the project can begin Phase 0 without inventing infrastructure and every owner-only prerequisite is documented.

MILESTONE GROUPS
----------------
MILESTONE A — Product and authority foundation: Phases 0–8
MILESTONE B — Sensing and intelligence: Phases 9–16
MILESTONE C — Durable execution and learning: Phases 17–25
MILESTONE D — Core Resource Fabric: Phases 26–31
MILESTONE E — Placement, economics, and storage: Phases 32–36
MILESTONE F — Resilience and provider scale: Phases 37–39
MILESTONE G — Simulation, operations, and companion surfaces: Phases 40–43
MILESTONE H — Final acceptance: Phase 44



==============================================================================
PHASE-BY-PHASE IMPLEMENTATION PLAN
==============================================================================


PHASE 0 — Repository, Runtime, Deployment, and Existing-UI Reconnaissance
--------------------------------------------------------------------------

GOAL
Understand the real starting point before changing behavior.

BUILD / VERIFY
- Inspect routes, components, state management, package/runtime, build scripts, tests, lint/typecheck, service workers, PWA manifest, auth, database schema, migrations, RLS, API/server functions, integrations, background workers, queues, schedules, CI/CD, hosting, domains, monitoring, backups, and secret-management paths.
- Map the current frontend against the supplied UFO v2 screenshot. Mark each screen/component as KEEP, MODIFY, CREATE, or REMOVE.
- Identify every browser-only, laptop-only, temporary-process, model-session dependency, direct provider coupling, or hard-coded model slug that would prevent 24/7 cloud execution or model interchangeability.
- Produce an architecture map, security/tenancy map, deployment topology, resource topology, AI-gateway/model-coupling map, and gap map for all later phases.
- Do not implement product features in this phase.

ACCEPTANCE
- Current app builds, or every pre-existing build failure is documented with evidence.
- Existing auth/RLS/tenant boundaries are understood.
- No secret values are copied into the report.
- Current deployment and background-execution model is known.
- Existing AI calls are classified as provider-neutral, gateway-routed, or provider-coupled.
- Agent can name the exact files/services likely to change in Phase 1.

EXPLICITLY DEFER
- No schema redesign, no resource scheduler, no new production integration.


PHASE 1 — UFO v2 Visual Baseline and Mobile Shell
--------------------------------------------------

GOAL
Lock the screenshot as the permanent owner-facing visual contract.

BUILD / VERIFY
- Implement or verify Sign In, Home/Chat, Decisions, Decision Detail, Resources, Add Resource, and Resource Detail.
- Permanent bottom navigation is exactly Chat | Decisions | Resources. No fourth permanent item.
- Home/Chat retains the conversational start screen and includes the quick action 'Check my resources'.
- Match the screenshot language: near-black background, electric-blue accent, restrained glow, premium dark cards, compact typography, rounded controls, minimal clutter, iPhone safe areas, keyboard-safe chat input, and responsive desktop behavior.
- Use seeded DEVELOPMENT data where backend functionality is not yet real, and label it clearly.

ACCEPTANCE
- All five screenshot experiences are faithfully represented.
- Common iPhone widths have no horizontal overflow.
- Chat input remains usable with the virtual keyboard open.
- Desktop responsive layout works without becoming an admin dashboard.
- Empty/loading/error/offline states exist.
- Existing Chat and Decisions behavior is not visually degraded.

EXPLICITLY DEFER
- No real resource enrollment, scheduling, credentials, or production side effects.


PHASE 2 — Authentication and Secure Sessions
---------------------------------------------

GOAL
Establish secure user identity and session behavior before adding authority.

BUILD / VERIFY
- Implement or harden user authentication, session creation, refresh, expiration, revocation, logout, and device-safe persistence.
- Support passkeys/WebAuthn architecture where platform support exists; biometric-backed authentication is OS/platform mediated, not stored by GetDone.
- Define step-up authentication as a separate capability for high-risk approvals.
- Ensure deep links never create authority merely by opening a route.

ACCEPTANCE
- Expired/revoked sessions cannot perform server actions.
- Session restoration works in standalone PWA mode.
- Step-up can be required independently of normal login.
- No biometric templates or raw authentication secrets are stored by GetDone.

EXPLICITLY DEFER
- No company/resource scope yet beyond the minimum required to test authentication.


PHASE 3 — Portfolios, Companies, Memberships, and Resource Scope
-----------------------------------------------------------------

GOAL
Create the server-authoritative hierarchy that all later business and resource actions depend on.

BUILD / VERIFY
- Implement User → Portfolio → Company hierarchy and memberships/roles.
- Add future-safe authorization concepts for Resource, ResourcePool, CredentialBinding, and ResourcePolicyBinding without implementing scheduling.
- Resolve portfolio_id, company_id, resource_id, pool_id, credential_binding_id, and policy scope server-side from authenticated identity and trusted bindings.
- Apply RLS/authorization to every company- or portfolio-owned table.

ACCEPTANCE
- User A cannot read or mutate User B's portfolio/company/resource records.
- Client-side ID tampering fails.
- Deep-linking to an unauthorized object grants no access.
- Revoking membership removes applicable authority.
- Cross-company leakage test suite passes.

EXPLICITLY DEFER
- No AI intelligence and no resource placement.


PHASE 4 — Company Onboarding and Business Integrations
-------------------------------------------------------

GOAL
Preserve v1 company activation while separating business integrations from infrastructure resources.

BUILD / VERIFY
- Implement/verify Company Details → Connect Tools → Authenticate → Review & Activate.
- Maintain business integration catalog such as Stripe, GitHub, Sentry, Analytics, HubSpot, Gmail, Slack, Notion, REST API, Webhook, and MCP as supported by the product.
- Keep read and write permissions explicit and separate.
- Keep OAuth/API credentials server-side and environment-scoped.
- Ensure compute/storage/network capacity lives under Resources, not Company Integrations.

ACCEPTANCE
- Connections belong to exactly one authorized company unless explicitly portfolio-scoped.
- Mock integrations are visibly DEVELOPMENT/MOCK.
- Disconnected integrations are actually unavailable.
- Production credentials cannot be consumed by staging.

EXPLICITLY DEFER
- No generalized execution adapter implementation beyond what onboarding needs.


PHASE 5 — Unified Capability Registry
--------------------------------------

GOAL
Make business intent and resource execution provider-neutral.

BUILD / VERIFY
- Create typed capability definitions for business actions (for example revenue.read, email.send, repository.inspect, production.deploy) and resource actions (for example compute.cpu.light, compute.gpu.inference, storage.backup, resource.health.read).
- Each capability records scope, provider/adapter binding, read/write class, sensitivity, production effect, reversibility, risk, cost model, blast radius, approval requirement, rate limit, typed input schema, typed output schema, and enabled state.
- Unknown or disabled capabilities fail closed.
- Do not provide unrestricted escape hatches such as execute_anything, call_any_api, run_arbitrary_command, use_any_resource, or bypass_policy.

ACCEPTANCE
- Changing provider adapter does not require changing business-task logic.
- Invalid input/output schemas fail validation.
- Disabled capability cannot execute.
- Company/resource scope is enforced independently of the caller's payload.

EXPLICITLY DEFER
- No autonomous planning.


PHASE 6 — Objectives, Guardrails, Budgets, and Infrastructure Objectives
-------------------------------------------------------------------------

GOAL
Give GetDone persistent intent without letting AI rewrite policy.

BUILD / VERIFY
- Implement standing objectives, measurable target metrics, priorities, deadlines, budgets, guardrails, and protected metrics.
- Support infrastructure objectives such as reducing variable compute cost without lowering reliability, maintaining protected capacity, and prohibiting HOME resources as the sole dependency for critical production.
- Keep objectives and guardrails separate.
- Paused objectives generate no new autonomous work.
- AI may propose changes but cannot silently modify either objectives or guardrails.

ACCEPTANCE
- Conflicting objectives can be detected and surfaced.
- Budget and reliability guardrails are queryable by the policy layer.
- Every objective has explicit authorized scope and measurable success criteria.

EXPLICITLY DEFER
- No task generation from objectives yet.


PHASE 7 — Deterministic Control Plane State Machines
-----------------------------------------------------

GOAL
Make GetDone, not AI or providers, authoritative for meaningful state.

BUILD / VERIFY
- Implement authoritative domain services/state machines for Goals, Plans, Decisions, Approvals, Tasks, Jobs, Events, Outcomes, and Audit.
- Predefine future resource entities: Resource, ResourcePool, PlacementRequest, PlacementDecision, Reservation, Allocation, Failover, and ResourceIncident.
- All meaningful transitions are server-authoritative and record actor, timestamp, scope, old state, new state, triggering event, and audit record.
- Implement global, portfolio, company, integration, capability, resource, pool, provider, failure-domain, and workload-class kill-switch concepts.

ACCEPTANCE
- Frontend cannot mark a job or resource successful.
- Invalid state transitions fail server-side.
- Duplicate requests cannot bypass state authority.
- Applicable kill switches block new work while preserving history.

EXPLICITLY DEFER
- No scheduler behavior.


PHASE 8 — Audit Ledger and Idempotency Foundation
--------------------------------------------------

GOAL
Make every consequential action reconstructable and safe to retry.

BUILD / VERIFY
- Create append-only audit/event records for important state changes and side effects.
- Standardize idempotency keys, request correlation IDs, actor identity, provenance, environment, and scope metadata.
- Define side-effect contract: authentication, known capability, policy evaluation, authorization, idempotency, timeout, retry policy, failure state, auditability, cancellation where appropriate, and verification.
- Add provider/webhook signature verification helpers.

ACCEPTANCE
- Retrying an idempotent command cannot duplicate its logical side effect.
- Audit chain can reconstruct who/what initiated a state change.
- Unauthenticated or forged callbacks cannot alter authoritative state.

EXPLICITLY DEFER
- No high-volume signal ingestion yet.


PHASE 9 — Unified Signal Bus
-----------------------------

GOAL
Normalize business and infrastructure events into one scoped sensing substrate.

BUILD / VERIFY
- Create raw event ingestion, normalization, deduplication, scope resolution, provenance, and normalized signals.
- Business signals and future resource signals share the same event architecture.
- Resource signal types include added, ready, offline, degraded, saturated, capacity-low, cost-spike, failover, credential-failure, policy-violation, drain-started, and drain-complete.
- Do not invoke expensive AI for every event.

ACCEPTANCE
- Duplicate webhook/event does not duplicate logical signals.
- Out-of-order events are safe.
- Payload alone cannot determine company/resource authority.
- Signal ingestion continues with phone/browser closed.

EXPLICITLY DEFER
- No intelligent investigation yet.


PHASE 10 — Sensing Engine and Deterministic Attention Filtering
----------------------------------------------------------------

GOAL
Continuously decide what deserves attention using cheap deterministic logic first.

BUILD / VERIFY
- Classify signals as informational, expected, threshold, anomaly, trend, opportunity, risk, goal drift, or incident.
- Emit only IGNORE, RECORD, MONITOR, INVESTIGATE, or ESCALATE.
- Use company/resource-specific baselines, threshold windows, freshness checks, deduplication, and cool-downs.
- Create investigations only when conditions warrant.

ACCEPTANCE
- Normal fluctuations do not trigger expensive reasoning.
- Sustained negative changes create investigation.
- Major error spikes escalate.
- Sensing remains operational while client devices are offline.

EXPLICITLY DEFER
- No web research or model reasoning.


PHASE 11 — External Intelligence Missions
------------------------------------------

GOAL
Allow scheduled research to augment internal signals without becoming authority.

BUILD / VERIFY
- Create scheduled research missions for competitors, pricing, SEO, keywords, market developments, technology changes, and public customer signals.
- Store source/reference, retrieved_at, scope relevance, freshness, confidence, and provenance.
- Apply rate/cost limits.
- Research failures never block core internal operations.

ACCEPTANCE
- Unsupported web claims cannot silently become authoritative facts.
- Stale evidence is labeled.
- Research is scoped to the correct company/objective.
- Research never authorizes an action.

EXPLICITLY DEFER
- No model-generated plan execution.


PHASE 12 — Context Assembler
-----------------------------

GOAL
Give reasoning models only the minimum relevant, authorized evidence.

BUILD / VERIFY
- Implement context services for company context, portfolio context, facts, signals, outcomes, decisions, policies, capabilities, and later resources.
- Bound context size and exclude irrelevant sensitive information.
- Preserve source, freshness, scope, and company attribution.
- Create resource-context placeholders for later health/capacity/policy/placement summaries.

ACCEPTANCE
- Company A context contains no Company B private details.
- Portfolio summaries preserve company attribution.
- Context is bounded and provenance-aware.
- Unauthorized resource details never enter prompts.

EXPLICITLY DEFER
- No model authority.


PHASE 13 — Interchangeable AI Gateway, Model Router, and Cognition
-----------------------------------------------------------------

GOAL
Add provider-neutral reasoning through OpenRouter while keeping deterministic systems authoritative and making models interchangeable without application rewrites.

BUILD / VERIFY
- Create a GetDone-owned AI Gateway interface. Runtime business logic calls this interface, never OpenAI/Anthropic/Google/model-specific SDKs directly.
- Implement OpenRouter as the default gateway adapter using one server-side environment-scoped API credential/binding.
- Add secure owner setup: submit OpenRouter key → server-side verification/canary → secret storage/reference → connection status. Never echo the stored raw key.
- Define model role classes: DETERMINISTIC, LIGHTWEIGHT, STANDARD, HIGH_REASONING, CODING, VISION, and LONG_CONTEXT. DETERMINISTIC performs no LLM call.
- Create an AI requirement envelope for each model-backed task: required role, modalities, tool support, structured-output requirement, context requirement, data classification, environment, latency target, cost ceiling, retry/fallback allowance, and optional model exclusions/pins.
- Create ModelProfile / ModelRoute configuration independent of business-task code. Profiles include gateway/provider/model identifier, capabilities, context window metadata, tool/vision/structured-output support, cost/latency metadata, allowed data classes/environments, health, enabled state, and validation status.
- OpenRouter catalog metadata may assist discovery, but security-sensitive capability claims must be validated by GetDone configuration and/or canary tests before eligibility.
- Routing order: task requirements → deterministic eligibility filters → configured role route → cost/latency preference → OpenRouter model/provider selection → response validation.
- Support ordered fallbacks only among models that already satisfy hard requirements. A cheaper/faster fallback may never weaken modality, tool, data, environment, security, or structured-output requirements.
- Support OpenRouter provider failover and model fallback where appropriate, but keep GetDone's own allow-list and audit policy authoritative.
- Permit an automatic/optimized routing profile for low-risk eligible work; sensitive or high-impact cognition must use explicitly approved route classes/models according to policy.
- Reserve HIGH_REASONING for architecture, complex investigation, root cause, cross-system reasoning, planning, security, and adversarial review.
- Route CODING tasks only to models validated for the software-worker contract. Route VISION tasks only to models validated for image input.
- Require structured outputs containing findings, evidence, assumptions, unknowns, alternatives, recommendation, confidence, and requested capabilities where the task contract requires them.
- Normalize model responses into GetDone-owned schemas so switching model families does not change downstream business logic.
- Record request correlation ID, role/requirements, requested route, actual model/provider when available, fallback chain/reason, latency, usage/cost, validation status, and failure class.
- Add per-company/portfolio/global AI budgets, rate limits, concurrency limits, and optional model/provider kill switches.
- Do not store private chain-of-thought; store concise rationale summaries and evidence.
- Never expose OpenRouter or downstream provider credentials to model prompts, frontend code, or worker logs.
- Keep a second gateway-adapter interface available for future direct-provider or alternate-gateway support without changing task semantics.

ACCEPTANCE
- Owner can configure one OpenRouter API key and successfully run an allowed canary through the server-side gateway.
- Raw key cannot be read back from the browser, logs, prompts, reports, or model metadata.
- Changing the model mapped to STANDARD or HIGH_REASONING requires configuration only; no business-task code change.
- A task requiring vision cannot route to a text-only model.
- A task requiring tool/structured-output support cannot route to a model that failed those capability checks.
- Primary-model failure can fall back to another pre-approved eligible model and the actual model used is auditable.
- If no eligible model exists, the request fails gracefully with a typed AI_UNAVAILABLE / NO_ELIGIBLE_MODEL state rather than silently weakening requirements.
- Malformed or schema-invalid model output fails validation and cannot mutate authoritative state.
- Model/provider/route kill switches block new applicable calls.
- Cheap deterministic work is not routed to paid reasoning by default.
- Model calls are metered, budget-aware, and auditable.
- Model cannot directly change authoritative state, authorize production, approve spending, alter policy, or set execution truth.

EXPLICITLY DEFER
- No execution authorization.
- No autonomous model-policy self-modification.


PHASE 14 — Plan Construction
-----------------------------

GOAL
Turn objectives/investigations into structured proposed plans.

BUILD / VERIFY
- Create plan schema with goal, scope, evidence, assumptions, steps, dependencies, requested capabilities, expected outcomes, costs, risks, rollback/mitigation, and verification requirements.
- Allow model-generated proposals only through the GetDone AI Gateway and strict GetDone-owned schema validation; downstream plan semantics must not depend on the model family used.
- Represent infrastructure intentions as capability/resource requirements, not hard-coded machine selections.

ACCEPTANCE
- Every plan step traces to an objective, investigation, or explicit owner request.
- Plans with missing scope or unsupported capabilities are rejected.
- Plans are proposals only.

EXPLICITLY DEFER
- No authorization or dispatch.


PHASE 15 — Plan Validator
--------------------------

GOAL
Deterministically validate business and infrastructure plans before authorization.

BUILD / VERIFY
- Validate capability fit, scope, policy, data classification, region, environment, dependencies, contradictions, duplicate work, cost ceilings, current health/capacity references, credential availability, reliability, and fallback requirements.
- Return structured errors/warnings and required owner decisions.
- Validator cannot authorize execution. AI route/model selection cannot relax validation requirements.

ACCEPTANCE
- Contradictory or incomplete plans fail before task compilation.
- Unavailable capabilities are caught.
- Resource policy problems are caught even when the proposed resource is cheaper/faster.

EXPLICITLY DEFER
- No approval decision yet.


PHASE 16 — Policy, Preflight, and Mobile Authorization
-------------------------------------------------------

GOAL
Decide what is AUTO, APPROVAL_REQUIRED, STRONG_APPROVAL, or BLOCKED.

BUILD / VERIFY
- Implement deterministic policy evaluation for business and resource actions.
- Preflight checks include identity, scope, capability, environment, policy, data class, region, credential binding, budget, protected headroom, fallback requirement, idempotency, and kill switches.
- Use the existing Decisions queue as the single approval surface.
- Support secure deep links into decision details and step-up authentication.
- Text or voice 'yes' never satisfies a strong-approval requirement.

ACCEPTANCE
- Strong approval requires fresh step-up.
- Blocked actions cannot be forced by the model, AI gateway, fallback model, frontend, provider, or voice.
- Resource approvals appear in the same Decisions queue as business approvals.

EXPLICITLY DEFER
- No task dispatch.


PHASE 17 — Autonomous Task Generation
--------------------------------------

GOAL
Allow GetDone to create its own scoped work from approved plans, objectives, and detected conditions.

BUILD / VERIFY
- Generate tasks from authorized plans and validated investigations.
- Add infrastructure-origin triggers such as degradation, repeated resource error, cost anomaly, capacity shortage, credential expiry, and storage pressure.
- Every task stores immutable scope, reason, evidence, priority, capability requirements, and authorization lineage.
- Deduplicate equivalent tasks.

ACCEPTANCE
- Paused objectives create no new work.
- Repeated signals do not create duplicate logical tasks.
- Every task can explain why it exists.

EXPLICITLY DEFER
- No hardware placement yet.


PHASE 18 — Task Compiler and Executable DAG
--------------------------------------------

GOAL
Compile authorized intent into a deterministic executable graph.

BUILD / VERIFY
- Compile tasks into dependency-aware steps with typed capabilities, inputs, outputs, preconditions, verification steps, rollback/cancellation semantics, and resource requirement envelopes.
- Resource envelope may include CPU/RAM/GPU/VRAM, architecture, environment, deadline, priority, checkpointability, retryability, reliability tier, interruption class, data classification, allowed regions, locality preference, max job cost, and fallback requirement.
- Do not hard-code server IDs unless an explicit authorized pinning policy requires it.

ACCEPTANCE
- DAG rejects cycles/unsatisfied dependencies.
- Every executable node maps to a known capability.
- Resource needs are requirements, not arbitrary machine choices.

EXPLICITLY DEFER
- No actual resource selection.


PHASE 19 — Durable Cloud Job Engine
------------------------------------

GOAL
Keep authorized work running independently of phone/browser/model sessions.

BUILD / VERIFY
- Implement persistent queue, atomic claim, leases, worker heartbeat, timeout, retry/backoff, max attempts, dead letter, cancellation, recovery, idempotency, worker health, and schedules.
- Job Engine remains authoritative for job state.
- Add nullable references for future placement_request_id, placement_decision_id, reservation_id, allocation_id, resource_id, and resource_pool_id.
- Ensure already-authorized work survives client disconnect.

ACCEPTANCE
- Phone/browser can be closed without stopping jobs.
- Worker crash causes safe lease recovery.
- Duplicate delivery does not duplicate side effects.
- Job history remains auditable.

EXPLICITLY DEFER
- No resource scheduler authority yet.


PHASE 20 — Business Action Adapter Layer
-----------------------------------------

GOAL
Execute business capabilities behind replaceable adapters.

BUILD / VERIFY
- Implement adapter contract for direct APIs, n8n, webhooks, MCP, and specialized workers.
- Adapters receive only authorized, scoped, typed execution requests.
- Adapters cannot approve work, change scope, set job success, or bypass policy.
- Normalize provider errors and retry hints.

ACCEPTANCE
- A provider can be swapped without changing task semantics.
- Adapter callback alone cannot mark a job complete.
- Credentials remain server-side/scoped.

EXPLICITLY DEFER
- Resource provider adapters are handled later.


PHASE 21 — Software Worker and Deployment Pipeline
---------------------------------------------------

GOAL
Safely let GetDone modify software while preserving human control over production.

BUILD / VERIFY
- Implement repo inspection → isolated branch → modify → static analysis → tests → security checks → preview → staging → verification → approval → production → post-deploy health verification → rollback window → measurement. Coding cognition is requested through the GetDone AI Gateway CODING role; the software worker, repository controls, tests, and deployment state remain authoritative.
- Keep production authorization independent from whatever compute executes builds/tests.
- Record commit, diff, test evidence, deployment result, and rollback reference.

ACCEPTANCE
- Production deploy cannot occur without the configured approval.
- Failed verification blocks promotion.
- Swapping the CODING model route does not change repository/deployment authority or bypass tests.
- Rollback path is tested.
- Build/test execution can later be scheduled onto eligible resources without changing production authority.

EXPLICITLY DEFER
- No resource placement.


PHASE 22 — Verification, Measurement, and Outcomes
---------------------------------------------------

GOAL
Establish truth after execution.

BUILD / VERIFY
- Implement execution verification, system verification, and business verification.
- Prepare resource verification: intended placement, actual execution resource, capacity release, and cost/usage reconciliation.
- Do not treat provider 'accepted' or HTTP success alone as final business success.
- Store outcomes linked to objective, task, job, decision, and evidence.

ACCEPTANCE
- Success is evidence-based and reproducible.
- Verification failures produce failed/uncertain states rather than false success.
- Outcome metrics can later feed memory and learning.

EXPLICITLY DEFER
- No learned policy changes.


PHASE 23 — Memory and Operational Learning
-------------------------------------------

GOAL
Remember durable lessons without converting anecdotes into authority.

BUILD / VERIFY
- Store scoped facts, lessons, experiments, outcomes, evidence, sample size, confounders, confidence, and history.
- Retrieve only relevant lessons into future context.
- Allow suggested policy/placement changes but require deterministic policy workflow/approval before becoming authoritative.
- Do not store raw private chain-of-thought.

ACCEPTANCE
- One observation cannot automatically create permanent policy.
- Lessons retain scope and evidence.
- Cross-company memory leakage fails tests.

EXPLICITLY DEFER
- No resource-specific simulator yet.


PHASE 24 — Portfolio Intelligence and Security Hardening
---------------------------------------------------------

GOAL
Add executive cross-company visibility while adversarially validating isolation and authority.

BUILD / VERIFY
- Create portfolio summaries that preserve company attribution and authority boundaries.
- Threat-test auth, tenancy, RLS, integrations, callbacks, job state, approvals, credential scope, prompt/context contamination, AI gateway key handling, model substitution/fallback, malicious or malformed model output, model/provider kill switches, and production deployment boundaries.
- Add placeholders/tests for later resource impersonation, fake enrollment, forged heartbeat, capacity spoofing, reservation replay, and scheduler bypass.

ACCEPTANCE
- All adversarial cross-company access attempts fail.
- AI/gateway/model/provider/frontend cannot forge approval or job success.
- Security regression suite is automated.

EXPLICITLY DEFER
- No Resource Fabric implementation yet.


PHASE 25 — PWA Packaging, Push, and Mobile Delivery
----------------------------------------------------

GOAL
Ship the existing owner experience as a reliable iPhone-first control surface.

BUILD / VERIFY
- Standalone PWA launch, icons/manifest, safe areas, responsive layout, update strategy, offline/error shell, secure sessions, push notifications, notification deep links, passkey/WebAuthn support where available.
- Deep links cover Decision, Task/Result, Resource, Resource Incident, and Resource Decision.
- Notifications compress attention: FYI to history/results, Normal to Decisions, High/Critical to push according to policy.
- Lock screen content must avoid unnecessary sensitive details.

ACCEPTANCE
- Phone can be off while cloud jobs continue.
- Push/deep link navigation grants no authority by itself.
- Reconnection shows authoritative server state.
- Screenshot visual baseline remains intact.

EXPLICITLY DEFER
- Native Watch is later and optional.


PHASE 26 — Resource Domain and Authoritative Registry
------------------------------------------------------

GOAL
Create the authoritative vocabulary/inventory for infrastructure capacity.

BUILD / VERIFY
- Create resources, resource_pools, resource_capabilities, resource_bindings, resource_locations, resource_cost_profiles, resource_health_states, resource_lifecycle_events, resource_provider_bindings, and failure_domains.
- Support initial types: COMPUTE_NODE, COMPUTE_POOL, STORAGE, UTILITY_NODE, MODEL_ENDPOINT; keep schema extensible for NETWORK, DATABASE, GPU_POOL, COLO_CLUSTER, DATA_CENTER_POOL.
- Lifecycle: DISCOVERED, ENROLLING, PROFILING, VALIDATING, READY, DEGRADED, SATURATED, DRAINING, UNREACHABLE, FAILED, QUARANTINED, MAINTENANCE, DISABLED.
- Bind the screenshot Resources list/detail screens to real registry read models without exposing admin-console complexity.

ACCEPTANCE
- No resource becomes READY without verified identity, authorized scope, validated capabilities, trust classification, health method, environment permission, policy binding, and adapter binding.
- Provider/agent reports cannot directly set trust/policy/READY.
- Resource list/detail reads are tenant scoped.

EXPLICITLY DEFER
- No production scheduler.


PHASE 27 — Generic Resource Enrollment Workflow
------------------------------------------------

GOAL
Make Add Resource a real, unified workflow independent of provider type.

BUILD / VERIFY
- Implement IDENTIFY → CREATE_ENROLLMENT → OWNER_ACTION_IF_REQUIRED → AUTHENTICATE → DISCOVER → PROFILE → VALIDATE → TEST → REGISTER → READY.
- Enrollment records include requested type, actor, intended scope, environment permissions, one-time challenge/token reference, expiry, status, adapter path, required owner actions, and verification evidence.
- Manual category selection and plain-language Chat initiation converge on the same authoritative workflow.
- Owner-only blockers use a consistent handoff response with minimum required action.

ACCEPTANCE
- Expired/replayed enrollment token fails.
- Enrollment cannot grant broader scope than authorized.
- Cancellation/restart behavior is deterministic.
- Frontend cannot mark enrollment READY.

EXPLICITLY DEFER
- Node agent implementation is next.


PHASE 28 — Raspberry Pi / Linux Node Agent
-------------------------------------------

GOAL
Prove the Resource Fabric using the smallest real physical compute vertical slice.

BUILD / VERIFY
- Build a Linux ARM64 agent suitable for Raspberry Pi 5 class hardware.
- Agent establishes cryptographic identity, uses secure outbound connectivity where practical, heartbeats, reports version/capabilities, runs typed controlled jobs, reports health, supports revocation, and supports safe upgrade.
- Agent cannot hold broad portfolio secrets, choose its own trust level, set job success authoritatively, or expose arbitrary shell execution.
- Package install/enrollment so the owner performs only the unavoidable physical/security step.

ACCEPTANCE
- Enroll a real Pi, run lightweight canary, unplug it, observe UNREACHABLE/OFFLINE, reconnect it, and safely restore identity/eligibility.
- No important business state is lost when Pi disappears.
- Agent only executes typed permitted workloads.

EXPLICITLY DEFER
- No automatic production placement.


PHASE 29 — Secrets and Credential Broker
-----------------------------------------

GOAL
Separate resource identity from credential authority.

BUILD / VERIFY
- Create secret references, credential bindings/scopes/leases, rotation metadata, revocation, usage audit, and provider token exchange where supported. Formalize OpenRouter gateway credentials under the same server-side secret/binding discipline used during Phase 13 bootstrap implementation.
- Registry stores secret/credential references, never raw secrets.
- Flow: Authorized Job → Placement → Credential Request → validate job/resource/capability/company/environment/scope → issue minimum credential → secure delivery → execute → expire/revoke/release → audit.

ACCEPTANCE
- Home Pi cannot request data-center credentials.
- Company A cannot obtain Company B credentials.
- Staging cannot resolve production secrets.
- Disabled/removed resources lose applicable credential access.
- Raw credentials do not appear in browser bundles or logs.

EXPLICITLY DEFER
- No scheduler.


PHASE 30 — Resource Profiling, Capability Validation, and Telemetry
--------------------------------------------------------------------

GOAL
Determine what a resource really is and whether it remains usable.

BUILD / VERIFY
- Profile architecture, CPU, RAM, GPU/model/VRAM, disk, network, runtime, supported software, benchmark, latency, uptime, and available thermal/power information where appropriate.
- Normalize authenticated telemetry into time-series metrics and summarized authoritative health.
- Health states: HEALTHY, DEGRADED, SATURATED, DRAINING, UNREACHABLE, FAILED, QUARANTINED, MAINTENANCE.
- Emit signal-bus events for meaningful health/capacity transitions.
- Self-reported privileged capability claims require validation.

ACCEPTANCE
- Pi is classified only for capabilities it can actually support.
- Fabricated GPU/high-VRAM claim does not become authoritative.
- Stale telemetry produces safe degraded/unreachable behavior.

EXPLICITLY DEFER
- No placement.


PHASE 31 — Resource Policy and Data Classification
---------------------------------------------------

GOAL
Deterministically define where work and data may run.

BUILD / VERIFY
- Implement data classes: PUBLIC, INTERNAL, CUSTOMER, SENSITIVE, PRODUCTION_CRITICAL, REBUILDABLE, TEMPORARY, ARCHIVE, BACKUP, MODEL_ARTIFACT.
- Location classes: HOME, OFFICE, CLOUD, COLO, PARTNER_DC.
- Policy attributes include dev/staging/production allowed, customer/sensitive data allowed, regions, reliability tier, encryption requirements, fallback requirement, interruption class, and workload allow/deny classes.
- Default: HOME is optional capacity; production customer data is not placed there unless explicitly authorized; critical authoritative state cannot have its sole durable copy in a HOME failure domain.
- Hard constraints filter; preferences rank.

ACCEPTANCE
- A very powerful HOME GPU is rejected for prohibited workloads.
- Policy result is deterministic and explainable.
- Speed or price cannot override data/security/reliability rules.

EXPLICITLY DEFER
- No scheduler scoring yet.


PHASE 32 — Placement Request and Candidate Evaluation
------------------------------------------------------

GOAL
Build deterministic eligibility before any resource is reserved.

BUILD / VERIFY
- Server generates placement_request from an authorized job; frontend/model/provider cannot set authoritative eligibility.
- Request includes capability requirements, compute envelope, priority/deadline, checkpoint/retry properties, data class/regions/locality, reliability/fallback, budget/max cost, optional pin/exclusions, idempotency key, and expiry.
- Evaluate candidates through scope → policy → health → capability → capacity → credential/environment → cost ceiling filters.
- Persist reasons for every rejection and snapshots used in evaluation.
- Pinned resources still pass all hard constraints.

ACCEPTANCE
- Unauthorized/stale/unhealthy/under-capacity/policy-forbidden candidates are rejected.
- Same logical idempotency request does not create duplicate active placements.
- Candidate explanation is sufficient to answer 'why this resource?'.

EXPLICITLY DEFER
- No reservation or dispatch.


PHASE 33 — Reservation, Allocation, and Capacity Ledger
--------------------------------------------------------

GOAL
Prevent over-allocation and make capacity commitments durable.

BUILD / VERIFY
- Implement atomic reservations with leases/expiry, resource/pool capacity ledgers, reservation renewal, release, cancellation, and allocation records.
- Reservations belong to authorized jobs and placement decisions.
- Track requested versus granted capacity and protected headroom.
- Stale/abandoned reservations expire safely.

ACCEPTANCE
- Concurrent requests cannot over-allocate the same capacity.
- Reservation replay is idempotent.
- Expired reservation cannot be used to dispatch work.
- Release restores capacity exactly once.

EXPLICITLY DEFER
- No production auto-scheduling until dispatch/verification exists.


PHASE 34 — Scheduler Dispatch, Start Verification, and Release
---------------------------------------------------------------

GOAL
Complete deterministic placement from eligible candidate to verified running workload.

BUILD / VERIFY
- Rank only eligible candidates using explicit preferences such as reliability, locality, cost, startup latency, protected-capacity impact, and owner preferences.
- Create placement decision → reserve → dispatch through resource adapter → independently verify start → monitor → verify completion → release.
- Job Engine remains authoritative for job state; scheduler manages placement, not job truth.
- Retry/fallback creates new auditable placement decisions without silently changing policy.

ACCEPTANCE
- Scheduler never places on an ineligible resource.
- Provider 'accepted' is not enough; actual start is verified.
- Capacity is always released/expired.
- Every placement is explainable and audited.

EXPLICITLY DEFER
- Economic optimization beyond bounded scoring is next.


PHASE 35 — Cost and Capacity Governor
--------------------------------------

GOAL
Optimize economics without becoming an authority bypass.

BUILD / VERIFY
- Model owned, committed, reserved, spot/preemptible, and variable/on-demand capacity where available.
- Track effective cost, marginal cost, utilization, protected headroom, quotas, and budget bindings.
- Allow economics to rank eligible options, never override hard policy, reliability, data residency, or explicit guardrails.
- Reconcile estimated versus actual usage/cost.

ACCEPTANCE
- Cost-saving choice never violates hard constraints.
- Protected capacity is preserved.
- Budget caps can block or require approval.
- Estimated and actual cost can be compared per job/resource.

EXPLICITLY DEFER
- No policy simulator yet.


PHASE 36 — Storage Fabric and Data Placement
---------------------------------------------

GOAL
Treat storage placement separately from compute while allowing coordinated plans.

BUILD / VERIFY
- Model storage resources, storage capabilities, durability, encryption, residency, authoritative/non-authoritative role, data class, retention, locality, replication, backup/archive role, and recovery characteristics.
- Distinguish temporary/rebuildable artifacts from authoritative durable state.
- Allow compute placement to prefer data locality after hard policy passes.
- Implement Home NAS as the second real vertical slice after Pi compute is stable.

ACCEPTANCE
- HOME NAS can host approved cache/artifact/secondary-copy workloads without becoming accidental sole production authority.
- Unplugging HOME NAS does not break critical production.
- Data placement is explainable and policy constrained.

EXPLICITLY DEFER
- Automated failover orchestration comes next.


PHASE 37 — Failure Domains and Resilience Orchestrator
-------------------------------------------------------

GOAL
Handle correlated failure without corrupting authority.

BUILD / VERIFY
- Model host, rack/site, HOME, region, provider, and partner/data-center failure domains as applicable.
- Implement drain, circuit breakers, health-based admission control, retry, reroute, burst/fallback, checkpoint-aware recovery, and controlled failover.
- Keep existing healthy work in place when policy permits; stop inappropriate new placement during degradation.
- Estimate temporary cost impact and verify post-failover health.

ACCEPTANCE
- Pi failure reroutes eligible retryable work.
- Provider/pool degradation stops unsafe new placement.
- Failover actions are audited and verified.
- No recovery is claimed without evidence.

EXPLICITLY DEFER
- Partner/DC scaling adapter is next.


PHASE 38 — Resource Adapter SDK and Second Provider
----------------------------------------------------

GOAL
Prove provider replaceability with a formal resource-adapter contract.

BUILD / VERIFY
- Define adapter operations for discover, authenticate, capabilities, health, capacity, cost, reserve/allocate, dispatch, status, cancel, release, and provider metadata.
- Create conformance tests and a mock adapter that is explicitly DEVELOPMENT/MOCK.
- Implement one real non-Pi second provider/adapter appropriate to the existing infrastructure.
- Keep provider-specific logic outside business-task logic and policy.

ACCEPTANCE
- Second provider passes the same contract tests.
- Scheduler can switch providers without task-logic changes.
- Provider callback cannot set authoritative job success.

EXPLICITLY DEFER
- Large partner/data-center pool semantics are next.


PHASE 39 — Partner / Data-Center Pool Enrollment and Aggregate Capacity
------------------------------------------------------------------------

GOAL
Add large partner/colo capacity without turning GetDone into a server inventory console.

BUILD / VERIFY
- Enroll a partner/data-center as a governed pool using the same conceptual lifecycle as a Pi.
- Discover aggregate capacity, capability classes, quotas, region/failure-domain metadata, cost model, workload/data restrictions, and adapter version.
- Expose the pool as one concise owner-facing Resource Detail with deeper node details on demand.
- Do not require manual enrollment of every underlying server unless the provider model genuinely requires it.

ACCEPTANCE
- Pool is governed by the same scope/policy/credential/scheduler rules.
- Resource Detail can show health, capacity, utilization, cost, location, environments, data policy, reliability, auto-scheduling, and current workloads.
- Partner credentials remain brokered/scoped.

EXPLICITLY DEFER
- No AI policy changes.


PHASE 40 — Resource Intelligence and Zero-Side-Effect Policy Simulator
-----------------------------------------------------------------------

GOAL
Let GetDone explain and simulate infrastructure choices before changing policy.

BUILD / VERIFY
- Create read-only analysis over historical placements, costs, utilization, failures, queueing, outcomes, and AI-gateway usage/cost/route performance where relevant.
- Allow simulation of proposed policy/scheduler/guardrail changes with zero external side effects.
- Model expected cost, reliability, capacity, data-policy impact, and uncertainty.
- AI may recommend changes; deterministic approval/policy workflow remains authoritative. The model used for simulation/recommendation is replaceable through the AI Gateway and is recorded with the evidence.

ACCEPTANCE
- Simulation cannot dispatch jobs, reserve capacity, mutate policy, or access unauthorized secrets.
- Results include assumptions and uncertainty.
- Historical data is sufficiently labeled to avoid pretending projections are facts.

EXPLICITLY DEFER
- No automatic policy promotion.


PHASE 41 — Version Registry, Release Evidence, and Operating Manuals
---------------------------------------------------------------------

GOAL
Make every production version reconstructable before any coding agent modifies it again.

BUILD / VERIFY
- Create version registry linking Git commit, app version, DB migration/schema version, resource schema version, policy version, adapter versions, AI-gateway adapter version, model-role routing-policy version, deployment/environment manifest, acceptance evidence, and generated operating manuals.
- Generate human-readable operating manual plus machine-readable manifest.
- Never place raw secrets in manuals.
- Release flow: code → test → staging → verify → generate manual/manifest → diff → approval if required → production → verify → archive evidence.

ACCEPTANCE
- Agent can retrieve the exact deployed anatomy/version, including the active AI-gateway/routing-policy version, before a future change.
- Manual and manifest regenerate for each release.
- Release artifacts contain no raw secrets.

EXPLICITLY DEFER
- Voice/watch is separate.


PHASE 42 — Voice Intent and Secure Handoff
-------------------------------------------

GOAL
Make voice a low-friction query/initiation surface without making it an authority system.

BUILD / VERIFY
- Support intents such as What's important?, Check my resources, How's DC West?, Add my Raspberry Pi, Drain my home GPU, How much compute are we using?, and Why are we using provider X?
- Voice may query, initiate a workflow, receive summaries, or deep-link to secure iPhone setup/approval.
- Voice never casually accepts raw API keys/tokens, unscoped credentials, or strong approvals.
- Use the same Control API and policy system as the phone UI.

ACCEPTANCE
- Voice cannot bypass step-up approval.
- Sensitive setup cleanly hands off to secure phone/provider flow.
- Voice-created workflows are scoped and auditable.

EXPLICITLY DEFER
- Native Watch companion is optional next.


PHASE 43 — Native Apple Watch Companion (Optional Release Scope)
-----------------------------------------------------------------

GOAL
Provide a real thin watch control surface without pretending the PWA is a watch app.

BUILD / VERIFY
- Implement native iOS/watchOS companion or supported system-intent surface using the existing Control API.
- Support read summaries, notifications, workflow initiation, and deep links/handoff to iPhone.
- Watch is never a job runner, secret store, policy authority, or strong-approval bypass.
- Keep this phase non-blocking if Watch is explicitly deferred from the release.

ACCEPTANCE
- Watch uses server-authoritative state.
- Raw secrets never transit through casual watch input.
- Strong approval still requires the configured secure path.
- Phone/watch disconnection does not stop cloud execution.

EXPLICITLY DEFER
- None if Watch is in release scope; otherwise mark DEFERRED.


PHASE 44 — End-to-End Acceptance, Adversarial Tests, and Production Release Gate
---------------------------------------------------------------------------------

GOAL
Prove the complete v1 governed autonomy loop plus the v2 Resource Fabric under failure and attack conditions.

BUILD / VERIFY
- Run the full business autonomy acceptance suite.
- Run AI Gateway interchangeability suite: one OpenRouter key setup, role-based routing, model swap without business-code change, eligible fallback, ineligible fallback rejection, malformed-output rejection, model/provider kill switch, budget/rate-limit behavior, and gateway outage behavior.
- Run Pi enrollment/execution/unplug/fallback/reconnect test.
- Run Home NAS test ensuring nothing critical depends solely on the house.
- Run partner/data-center pool enrollment and aggregate-capacity test.
- Run economic optimization simulation and measured outcome test.
- Run data-center degradation/failover test.
- Run resource-policy attack suite: production data to HOME, staging→prod credential misuse, fake capability claim, provider success spoof, voice approval bypass, enrollment replay, forged heartbeat, capacity spoof, reservation replay.
- Run phone-off test while schedules, sensing, jobs, health monitoring, scheduling, failover, verification, and notifications continue.
- Verify release manuals/manifests, backups, restore path, environment isolation, observability, alerting, and kill switches.

ACCEPTANCE
- All blocking acceptance tests pass simultaneously for the chosen release scope.
- Screenshot-compatible UX remains simple: Chat, Decisions, Resources; one Add Resource flow; concise Resource Detail.
- AI is non-authoritative, the AI gateway/model pool is interchangeable, resources are capacity not authority, provider claims are independently verified, and audit can reconstruct every meaningful action including which model/provider actually handled model-backed work.
- Only after evidence passes is the release marked production ready.

EXPLICITLY DEFER
- None.

==============================================================================
FINAL RELEASE ACCEPTANCE MATRIX
==============================================================================

BASE GETDONE
[ ] Governed autonomous business loop passes.
[ ] Tenant isolation passes adversarial tests.
[ ] AI remains non-authoritative.
[ ] Durable jobs survive client disconnect and worker interruption.
[ ] Action adapters remain replaceable.
[ ] Production deployment retains approval + verification.
[ ] Memory/outcomes remain scoped.
[ ] Development/staging/production remain isolated.

AI GATEWAY / MODEL ROUTING
[ ] OpenRouter is implemented behind a GetDone-owned gateway adapter, not scattered through business logic.
[ ] Owner can connect one OpenRouter API key through a secure write-only server-side setup flow.
[ ] DEVELOPMENT/STAGING/PRODUCTION AI credentials and policies remain separated as configured.
[ ] LIGHTWEIGHT / STANDARD / HIGH_REASONING / CODING / VISION / LONG_CONTEXT roles are configuration-driven.
[ ] DETERMINISTIC work makes no model call.
[ ] Hard capability/data/environment/security filters run before model preference or cost optimization.
[ ] Models can be swapped per role without changing business-task code.
[ ] Fallback only selects pre-approved eligible models.
[ ] No eligible model produces a typed safe failure instead of weakened requirements.
[ ] Actual model/provider/route/fallback/usage is auditable.
[ ] Model/provider/route kill switches work.
[ ] AI budgets, rate limits, and concurrency controls work.
[ ] Malformed or adversarial model output cannot mutate authoritative state.
[ ] OpenRouter credential never appears in frontend bundles, prompts, normal logs, or manuals.
[ ] Alternate gateway/direct-provider adapter can be added later without changing task semantics.

FRONTEND
[ ] Screenshot remains the visual source of truth.
[ ] Chat is the primary intent surface.
[ ] Decisions is the single approval surface.
[ ] Resources is the third bottom-nav destination.
[ ] Home includes Check my resources.
[ ] Resources overview remains concise.
[ ] Add Resource supports all screenshot categories + plain language.
[ ] Resource Detail uses Overview / Usage / Cost / Health with deep detail on demand.
[ ] GetDone has not become an infrastructure admin console.

RESOURCE REGISTRY
[ ] Registry is authoritative for resource state.
[ ] Resource scope is server-authoritative.
[ ] Raspberry Pi enrolls as real compute.
[ ] Validated typed capabilities are used.
[ ] Lifecycle transitions are audited.

CREDENTIALS
[ ] Raw secrets remain outside Resource Registry/frontend/logs.
[ ] Broker enforces resource/company/environment/capability scope.
[ ] Production secrets never reach the frontend.
[ ] Compromised/removed resource access can be revoked.

SCHEDULER
[ ] Jobs express requirements, not arbitrary server IDs.
[ ] Hard constraints filter candidates.
[ ] Preferences rank only eligible candidates.
[ ] Capacity cannot be over-allocated.
[ ] Reservations are atomic, idempotent, leased, and expiring.
[ ] Placement decisions are explainable.
[ ] Provider success claims are independently verified.

ECONOMICS
[ ] Committed/owned/variable capacity is modeled where available.
[ ] Cost never overrides policy/reliability.
[ ] Protected headroom works.
[ ] Actual usage/cost reconciles to jobs/resources.

STORAGE
[ ] Data classification controls eligible storage.
[ ] Temporary/rebuildable data is distinct from authoritative state.
[ ] HOME storage cannot accidentally become sole production authority.
[ ] Data locality may influence placement but cannot override policy.

RESILIENCE
[ ] Failure domains are modeled.
[ ] Pi failure reroutes eligible work.
[ ] Provider/data-center degradation triggers controlled resilience.
[ ] Circuit breakers and drains work.
[ ] Failover is audited and verified.

PARTNER / DATA CENTER
[ ] Partner pool is governed as a pool, not a manual server list.
[ ] Adapter SDK supports a second provider.
[ ] Credentials remain brokered/scoped.
[ ] Data-center scale does not change the owner interaction model.

SIMULATION + OPERATIONS
[ ] Simulation has zero external side effects.
[ ] Resource events feed the Signal Bus.
[ ] AI can reason about resources without becoming authority.
[ ] Resource kill switches work.
[ ] Operating manual + machine manifest regenerate per release.
[ ] Manuals contain no raw secrets.

MOBILE / VOICE / WATCH
[ ] Phone can be completely off without stopping the control plane.
[ ] Resource decisions deep-link securely.
[ ] Voice cannot bypass approval.
[ ] If Watch is included: native companion uses the same server authority model.
[ ] If Watch is included: no raw-secret entry or strong-approval bypass.

END-TO-END ACCEPTANCE SCENARIOS
-------------------------------
A. Raspberry Pi
- Owner: "Add my Raspberry Pi as compute."
- Enroll → verify identity → profile → benchmark → validate → classify HOME → policy → canary → READY.
- Run an eligible real workload.
- Unplug Pi → heartbeat loss → no new placement → reroute retryable work → no important state lost.
- Reconnect → verify identity/health before eligibility resumes.

B. Home NAS
- Owner: "Use this wherever it makes sense, but nothing important should depend solely on my house."
- Approved cache/artifact/model/secondary-copy uses may run there.
- Sole authoritative production state must not move there.
- Unplug NAS → production continues.

C. Data-Center / Partner Pool
- Owner: "Add DC West as a compute resource."
- Secure credential handoff → adapter validation → aggregate capacity/capability/quota/region/cost/policy discovery → canary → fallback → READY.
- Resource Detail stays screenshot-simple.
- Do not manually enroll hundreds of underlying servers.

D. Economic Optimization
- Owner: "Reduce our compute cost by 20% without lowering reliability."
- Analyze history → simulate → preserve headroom/policy → propose/authorize changes → measure actual outcome.
- Projection uncertainty remains explicit.

E. Data-Center Degradation
- Detect degradation → stop unsafe new placement → retain safe healthy work → reroute/burst eligible workloads → estimate cost impact → verify health → audit → notify according to attention policy.

F. Resource Policy Attack
All must fail safely:
- force customer production data onto HOME resource
- staging worker requests production credential
- untrusted node claims privileged GPU capability
- provider callback tries to mark job complete
- voice/text "yes" tries to bypass step-up
- enrollment-token replay
- forged heartbeat/capacity
- reservation replay/overclaim
- kill-switch bypass
- cross-company placement

G. Phone Off
- Begin authorized work.
- Close app, lock phone, turn phone off.
- Sensing, jobs, health, scheduling, failover, verification, and notifications continue server-side.
- Restore phone; state is correct.

H. AI Gateway / Model Interchangeability
- Owner connects one OpenRouter API key through the secure setup flow.
- Run LIGHTWEIGHT, STANDARD, HIGH_REASONING, CODING, and VISION canaries where supported by configured routes.
- Change the STANDARD model mapping; rerun the same task contract without changing business logic.
- Force the primary model/provider to fail; verify fallback chooses only another eligible allow-listed route and records what actually ran.
- Attempt to route a vision/tool/structured-output requirement to an ineligible model; it must fail safely rather than downgrade requirements.
- Disable a model/provider/route with a kill switch; verify new calls stop while authoritative control-plane state remains healthy.
- Simulate OpenRouter outage; model-dependent work becomes typed unavailable/retryable while deterministic authorized workflows that do not require a fresh model call continue safely.

==============================================================================
COPY-PASTE PROMPT FOR EACH CODING-AGENT BUILD PHASE
==============================================================================

Use this at the beginning of each phase:

"Read the GetDone UFO v2 Master Build Plan and execute ONLY Phase [NUMBER].
Treat the supplied UFO v2 screenshot as the primary visual source of truth.
Inspect the current repository and the previous phase report before editing.
Do not implement future phases.
Preserve the authority rules:
AI thinks; GetDone authorizes; workers execute; resources supply capacity;
verification establishes truth.
Preserve the AI architecture: GetDone owns the AI contract; OpenRouter is the default gateway; models are interchangeable cognitive resources and never authority.
Keep Chat | Decisions | Resources as the only permanent bottom navigation.
Use deterministic server-side authority for scope, approvals, policy, job state,
resource trust, placement, credentials, verification, and kill switches.
Run the universal completion gate and return the required phase report.
If owner action is genuinely required, stop only at the minimum owner-only action."

==============================================================================
IMPLEMENTATION ORDER NOTES
==============================================================================

1. Do not build every provider/data-center integration first.
2. Prove the smallest generic Resource Fabric slice with a real Raspberry Pi.
3. Prove identity, enrollment, health, typed capability validation, policy, placement,
   reservation, failure, and fallback before large-scale pools.
4. Add Home NAS only after compute enrollment/authority is stable.
5. Add one second provider to prove adapter replaceability.
6. Add partner/data-center pools through the same adapter contract.
7. Add economics only after deterministic placement is real.
8. Add resilience only after health + allocations are real.
9. Add the simulator only after enough real placement/cost history exists.
10. Generate operating manuals continuously once schemas stabilize; make them a release gate.
11. Treat Apple Watch as a thin companion on the same API, never a job runner/authority.
12. Keep the owner experience screenshot-simple throughout.
13. Implement OpenRouter behind the GetDone AI Gateway abstraction; do not scatter OpenRouter calls through feature code.
14. Make model role mappings configuration-driven and keep task contracts model-family-neutral.
15. Prove model interchangeability and safe fallback before relying on automatic routing for high-impact cognition.
16. Treat one OpenRouter API key as the normal owner setup path, but preserve an adapter seam so another gateway/direct provider can be added later.
17. Never allow model fallback, Auto routing, or lower cost to weaken hard capability, data, environment, security, approval, or authority requirements.

FINAL PRODUCT PRINCIPLE
-----------------------
UFO v2 should look only modestly different from GetDone v1 while becoming dramatically
more capable underneath.

The owner should mainly notice:
- one new primary destination: Resources
- one Home quick action: Check my resources
- resource decisions in the same Decisions queue
- one simple Add Resource workflow
- one concise Resource Detail screen

The backend may manage interchangeable AI models through a governed gateway, compute, storage, network access, credentials, workload placement,
reservations, infrastructure economics, failure domains, failover, provider pools, and
release manuals.

MORE CAPABILITY.
NO PROPORTIONAL INCREASE IN OWNER COMPLEXITY.
