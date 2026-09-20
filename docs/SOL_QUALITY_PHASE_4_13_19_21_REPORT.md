# Sol Quality + Phase 4 / 13 / 19–21 Deterministic Tranche

This report records the repository hardening and deterministic contract work added after Phase 42.

## Scope

This tranche intentionally combines four low-risk deterministic areas that share authority and release boundaries:

1. Architecture Quality & Contract Integrity
2. Phase 13 provider-neutral AI Gateway foundation
3. Phase 4 Company Integration Registry
4. Phases 19–21 durable execution / action adapter / software-worker contracts

No live provider, OAuth flow, OpenRouter call, production queue, production business adapter, or production deployment executor is claimed.

## Architecture Quality & Contract Integrity

### Resource Fabric refactor

The stable public entrypoints remain:

- `@/lib/resources/scheduler`
- `@/lib/resources/reservations`

Their implementations are now split behind internal modules:

- `lib/resources/internal/scheduler-types.ts`
- `lib/resources/internal/scheduler-core.ts`
- `lib/resources/internal/reservation-types.ts`
- `lib/resources/internal/reservation-core.ts`

Existing callers continue importing the original public paths. The dependency matrix rejects new imports of Resource Fabric internals from feature/UI code.

### Dependency-boundary matrix

Added `architecture/dependency-boundaries.json`.

`npm run verify:architecture` now applies machine-readable import boundaries covering:
- Resource Fabric internals;
- voice non-authority;
- AI Gateway cognition-only boundary;
- Integration Registry non-execution boundary;
- business adapters cannot authorize;
- frontend cannot import execution authority.

Existing product invariants remain enforced:
- permanent Chat / Decisions / Resources navigation;
- no provider/model SDK or HTTP endpoint outside `lib/ai-gateway`;
- no secret-like public environment variables;
- DEVELOPMENT seed data remains behind the repository seam;
- simulator remains zero-side-effect;
- Phase 34/42 authority guards remain present.

### Control-plane coverage gate

Added:
- `architecture/coverage-policy.json`
- `scripts/verify-control-plane-coverage.mjs`
- `npm run verify:coverage`

This dependency-free gate collects module/test-contract coverage for critical control-plane boundaries and emits:

`coverage/control-plane-module-coverage.json`

CI requires 100% coverage of the explicitly listed critical modules and a minimum mapped test-case count. This is a module/test-contract coverage threshold rather than pretending an uninstalled line-coverage provider exists. The generated report is archived with release evidence.

### Contract-version drift gate

Added `scripts/verify-contract-versions.mjs` and `npm run verify:contract-versions`.

Tracked contract-only source files are listed in `release/version-registry.json` using:
- `contractTracked: true`
- `contractSourcePaths`

On CI, if an existing tracked contract source changes while its declared semantic version remains unchanged, the build fails.

Newly tracked contracts establish a baseline on this tranche; subsequent changes require version movement.

### Adversarial contract vectors

Added `lib/security/adversarial-contract-vectors.ts` with machine-readable cases covering:
- ineligible AI fallback;
- AI provider kill switch;
- cross-company integration misuse;
- raw integration secret injection;
- stale Job lease;
- provider accepted != Job success;
- production software promotion without approval;
- Resource Fabric internal bypass;
- voice approval bypass.

## Phase 13 — Deterministic AI Gateway

Added `lib/ai-gateway/`.

Versioned contracts:
- `AI_GATEWAY_CONTRACT_VERSION = 1.0.0`
- `AI_ROUTING_POLICY_CONTRACT_VERSION = 1.0.0`

Implemented:
- provider-neutral `AIGateway` and `AIGatewayAdapter`;
- role classes: DETERMINISTIC, LIGHTWEIGHT, STANDARD, HIGH_REASONING, CODING, VISION, LONG_CONTEXT;
- `AIRequirementEnvelope`;
- `ModelProfile` and configuration-driven `ModelRoutePolicy`;
- deterministic hard eligibility for role, modality, tool support, structured output, context, data class, environment, latency, pin/exclusion, cost ceiling and kill switches;
- ordered fallback only among already-eligible profiles;
- typed `NO_ELIGIBLE_MODEL` unavailable result;
- DETERMINISTIC work is prohibited from invoking a model adapter;
- budget and concurrency admission contracts;
- output-schema validation before a result is returned;
- actual model/provider/profile/usage/latency audit contracts;
- DEVELOPMENT-only mock adapter for tests.

Still not connected:
- OpenRouter key/storage;
- OpenRouter HTTP adapter;
- canary validation against real models/providers;
- live provider failover;
- persistent budget/usage stores;
- production routing configuration.

The release registry therefore records the deterministic contract while live adapter/routing state remains `UNIMPLEMENTED` / `UNCONFIGURED`.

## Phase 4 — Deterministic Company Integration Registry

Added `lib/integrations/`.

Implemented:
- supported integration kinds;
- company/portfolio/environment-scoped integration records;
- explicit read scopes and write scopes;
- credential-binding references only;
- disconnected/authenticating/connected/degraded/disabled/revoked lifecycle;
- adapter authentication evidence;
- deterministic activation/deactivation;
- trusted company/environment scope enforcement;
- DEVELOPMENT-only mock adapter;
- tenant and raw-credential-shape tests;
- store interface without production persistence.

Still not connected:
- real OAuth/API providers;
- token exchange/refresh;
- production integration persistence;
- webhooks/provider callbacks.

## Phase 19 — Durable Job Runtime Contracts

Added `lib/execution/job-runtime-contracts.ts`.

Implemented:
- authorization/idempotency-bound durable queue envelope;
- atomic claim contract;
- worker lease/heartbeat/expiry model;
- retry scheduling contract;
- dead-letter contract;
- cancellation/recovery contract;
- durable store interface;
- lease integrity/freshness helpers.

No in-memory store is presented as production evidence.

Still not connected:
- production database/queue;
- multi-worker atomic claim proof;
- schedules;
- crash-recovery process;
- real workers.

## Phase 20 — Business Action Adapter Contracts

Added `lib/execution/adapters/`.

Implemented:
- authorized scoped typed business action request;
- authorization-consumption and idempotency lineage;
- production credential-lease reference requirement;
- provider result/status contracts;
- `jobStateMutationApplied: false`;
- adapter conformance harness;
- DEVELOPMENT-only mock adapter.

Provider accepted/completed remains evidence only. JobService + verification remain authoritative.

Still not connected:
- direct APIs;
- n8n;
- real webhooks/MCP executors;
- production credential delivery.

## Phase 21 — Software Worker / Deployment Contracts

Added `lib/execution/software-worker.ts`.

Implemented deterministic pipeline states for:
- inspect;
- isolated branch;
- modify;
- static analysis;
- tests;
- security checks;
- preview;
- staging;
- staging verification;
- production approval;
- production deployment;
- post-deploy verification;
- rollback/failure/success.

The software plan fixes cognition to the AI Gateway `CODING` role while keeping repository/deployment authority outside the model.

Production authorization requires a scoped, fresh promotion receipt containing approval and staging-verification lineage. A provider/deployment executor cannot establish final production success by itself.

Still not connected:
- live GitHub branch/commit operations;
- build/test runners;
- staging host;
- production deploy provider;
- rollback executor;
- post-deploy verifier.

## Phase 41 release-truth extension

Machine-readable formats advance to:
- version registry schema: `1.2.0`;
- environment manifest schema: `1.2.0`;
- generated release manifest schema: `1.2.0`.

Release truth now distinguishes deterministic contracts from live connectivity for:
- AI Gateway;
- Integration Registry;
- durable Job runtime;
- business action adapter;
- software worker/deployment.

Generated release evidence also binds the control-plane coverage report and CI records both the architecture and contract-version gates.

## Remaining drift / runtime gaps

No authority-model drift is introduced by this tranche.

The largest remaining gaps are live infrastructure:
- Phase 2/3 auth/database/migrations/RLS;
- Phase 4 real integrations and persistence;
- Phase 13 OpenRouter/live AI Gateway adapter, canaries, secrets and routing configuration;
- Phase 19 durable queue/store/workers and crash recovery;
- Phase 20 real business action adapters;
- Phase 21 real software-worker/repository/staging/production executor;
- Phase 28 Pi/Linux agent;
- Phase 29 real secret backend/token exchange;
- Phase 30 live telemetry;
- Phase 33 transactional reservation persistence;
- Phase 34 live resource dispatch/probes/recovery and JobService bridge;
- Phase 35 live billing/usage;
- Phases 36–39 storage/resilience/second-provider/partner-pool implementation;
- Phase 40 durable production analytics/calibration;
- Phase 42 live speech/native-iPhone transport;
- Phase 43 optional Watch;
- Phase 44 production end-to-end acceptance.

Deterministic contract existence must not be treated as canonical production PASS where the master plan requires real runtime evidence.
