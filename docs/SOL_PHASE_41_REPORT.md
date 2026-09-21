# Sol Phase 41 — Version Registry, Release Evidence, and Operating Manuals

This report records the deterministic Phase 41 implementation.

## Machine-readable version registry

Added `release/version-registry.json`.

It declares:
- registry schema/version;
- application version;
- version labels plus source paths for Control API, capability, plan, Resource, verification, credential, placement, reservation, scheduler, governor, simulator, and release-manifest schemas/contracts;
- database connection state plus migration/schema version;
- policy registry version and policy-engine version;
- AI Gateway connection state, adapter version, and model-role routing-policy version;
- adapter contract/implementation status and versions;
- deployment/environment manifest path;
- acceptance-evidence sources;
- manual sources;
- generated artifact paths.

Version labels are not accepted by themselves. The generated release manifest also hashes the exact source file behind every declared schema/adapter version.

## Explicit absence instead of invented versions

The current repository has no authoritative database migrations, live AI Gateway, routing policy, real business-action adapter, or live Resource Dispatch adapter.

Phase 41 records those facts explicitly:
- database: `not-connected`, migration/schema `UNIMPLEMENTED`;
- AI Gateway deterministic contract/router exists, while live adapter remains `not-connected`, adapter `UNIMPLEMENTED`, active routing policy `UNCONFIGURED`;
- resource-dispatch and atomic-reservation-store adapters: `contract-only`;
- Integration Registry exists while live integration adapters remain `not-connected`;
- durable Job runtime contract exists while the production DurableJobStore remains `not-connected`;
- business-action and software-deployment adapters are `contract-only` while live executors remain `not-connected`.

This prevents missing production infrastructure from being mistaken for an implicit current version.

## Environment/deployment manifest

Added `release/environment-manifest.json`.

Development, staging, and production each declare:
- authority mode;
- production-readiness flag;
- data mode;
- deployment state/ID/region;
- auth/database/AI Gateway/durable Job Engine/resource agent/transactional reservation store/resource dispatch/live telemetry/billing connection state.

Production remains explicitly not ready.

## Generated release evidence

Added `scripts/generate-release-artifacts.mjs`.

For the exact checked-out commit it generates:
- `release/out/release-manifest.json`;
- `release/out/OPERATING_MANUAL.md`.

The machine manifest binds:
- Git SHA;
- app version;
- package-lock SHA-256;
- registry SHA-256;
- schema versions and exact source hashes;
- database migration/schema state and source hash;
- policy versions and source hashes;
- AI Gateway/routing state and source hash;
- adapter versions/status/source hashes;
- environment manifest and hash;
- GitHub Actions/local CI evidence;
- acceptance-evidence document hashes;
- manual-source hashes;
- generated operating-manual hash;
- overall manifest integrity hash.

The operating manual presents the same anatomy in human-readable form and preserves the authority rule.

## CI release validation

Added:
- `npm run release:generate`;
- `npm run verify:release`;
- Phase 41 registry tests;
- architecture-gate assertions for the registry/environment/release steps.

CI now runs the normal runtime/secrets/architecture/type/lint/test/build gates first, then generates and verifies Phase 41 evidence and archives `release/out/` as a GitHub Actions artifact.

The verifier fails closed on:
- Git SHA mismatch;
- app-version drift;
- registry/environment/package-lock hash drift;
- schema/adapter source drift;
- policy-version drift;
- inconsistent database or AI Gateway connection/version declarations;
- acceptance/manual source drift;
- generated manual hash mismatch;
- impossible production-ready declaration while required connections remain false;
- CI evidence mismatch;
- raw-secret-shaped material in release artifacts.

## Canonical release-flow representation

The generated manual records the canonical flow:

`code -> test -> staging -> verify -> generate manual/manifest -> diff -> approval if required -> production -> verify -> archive evidence`

Phase 41 does not claim that currently disconnected staging/production steps have happened. It records their incomplete state.

## Remaining drift after Phase 41

No new product-model or authority drift was found.

Remaining differences from the canonical plan are implementation/runtime gaps:
- Phase 2/3 production auth/database/RLS and real DB migrations remain absent;
- Phase 13 live AI Gateway/OpenRouter routing and real routing-policy version remain absent;
- Phase 19 durable distributed Job Engine remains absent;
- Phase 20 real business action adapters remain absent;
- Phase 28 real Pi/Linux agent remains absent;
- Phase 29 production secret backend/token exchange remains absent;
- Phase 30 live authenticated telemetry remains absent;
- Phase 33 transactional persistence and multi-process concurrency proof remain absent;
- Phase 34 live resource adapters/probes/recovery and durable production Job-bridge persistence remain absent;
- Phase 35 live billing/usage feeds remain absent;
- Phases 36-39 production storage/resilience/second-provider/partner-DC work remain open;
- Phase 40 production historical stores/calibration remain absent;
- Phase 42 deterministic voice contracts/release binding are now implemented, but live speech/native-iPhone voice transport remains absent;
- Phase 43 optional Watch and Phase 44 production end-to-end gate remain open.

Phase 41 now makes those absences machine-visible rather than leaving them implicit.


## Phase 42 extension

Phase 42 extends this release-truth layer rather than creating a parallel version system.

The release schemas are now versioned as registry `1.4.0`, environment manifest `1.4.0`, and generated release manifest `1.4.0` after adding the verified Job-execution bridge and cross-phase golden-path composition evidence.

The registry/manifest/manual now also bind:
- voice intent contract version;
- voice adapter-contract version;
- live adapter/provider state;
- strong-approval and credential handoff mode;
- per-environment voice connection/authority state;
- Phase 42 source/test/report evidence hashes.

Release verification now fails closed if voice contract versions drift, if a disconnected runtime invents a provider/version, if voice authority is weakened, or if environment voice state contradicts the registry.


## Quality + deterministic Phase 4/13/19–21 extension

The release registry now tracks semantic contract versions for the new AI Gateway, Integration Registry, Job runtime, business action adapter, software worker, and the refactored Resource Fabric contract files.

`npm run verify:contract-versions` compares tracked contract sources with the previous Git baseline and requires a version bump when an established tracked contract changes.

`npm run verify:coverage` emits `coverage/control-plane-module-coverage.json`; CI binds that generated quality evidence into the release manifest before verification/archive.

The environment manifest keeps live AI, integration, durable-job, business-action, and software-deployment connections false while separately recording deterministic contract availability.


## Deterministic Phases 36–39 + Phase 44 extension

The version registry now binds contract versions/source hashes for Storage Fabric, resilience/failover, Resource Adapter SDK, aggregate ResourcePool, and the Phase 44 deterministic adversarial harness.

The environment manifest separately records that storage runtime, failover runtime, second provider, partner-pool runtime, and full production Phase 44 acceptance are still unconnected/not-run.

Release generation and verification now include those contract sources and fail closed if a release claims live Phase 36–39 infrastructure or production Phase 44 acceptance before corresponding state is explicitly connected.


## Verified Job bridge + golden-path composition extension

The registry now tracks:
- `JOB_EXECUTION_BRIDGE_CONTRACT_VERSION = 1.0.0`;
- `GOLDEN_PATH_HARNESS_VERSION = 1.0.0`;
- deterministic Job bridge presence separately from the unconnected live authoritative bridge store;
- deterministic simulation-only golden-path status with `productionExecutionClaimed=false`.

The generated manual/manifest bind exact source hashes, tests, the composition report, and per-environment bridge/composition declarations. Release verification fails closed if the harness overclaims production or the bridge is reported live without a connected authoritative store.
