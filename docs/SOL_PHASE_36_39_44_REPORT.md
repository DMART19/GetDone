# Sol Phases 36–39 + Phase 44 Deterministic Report

This report records the deterministic Resource Fabric and adversarial-harness tranche implemented after the quality / Phase 4 / Phase 13 / Phases 19–21 tranche.

## Scope

Implemented with Sol 5.6:

- Phase 36 — Storage Fabric and Data Placement contracts
- Phase 37 — Failure Domains and Resilience Orchestrator contracts
- Phase 38 — Resource Adapter SDK + conformance harness
- Phase 39 — Governed aggregate ResourcePool contracts
- Phase 44 — deterministic offline adversarial harness

Explicitly not claimed:

- real Home NAS integration;
- real Raspberry Pi/Linux runtime;
- real cloud/colo/partner adapters;
- production failover execution;
- production partner/DC enrollment;
- full production Phase 44 acceptance.

## Phase 36 — Storage Fabric

Added `lib/resources/storage-fabric.ts`.

Version:

`STORAGE_FABRIC_CONTRACT_VERSION = 1.0.0`

Implemented:

- typed storage data objects with:
  - data class;
  - authoritative/non-authoritative distinction;
  - rebuildability;
  - retention;
  - replication factor;
  - RPO/RTO;
  - required regions;
  - hash-bound identity;
- typed storage resource snapshots with:
  - capacity/available capacity;
  - encryption-at-rest/in-transit;
  - durability class;
  - authoritative/backup/archive capability;
  - location class/region/failure-domain membership;
  - reliability;
  - RPO/RTO;
  - state/freshness;
- deterministic storage-placement evaluation;
- separate storage roles:
  - authoritative primary;
  - authoritative secondary;
  - cache;
  - artifact;
  - backup;
  - archive;
  - temporary;
  - rebuildable;
- HOME guardrails:
  - HOME cannot become unqualified production authority for CUSTOMER/SENSITIVE/PRODUCTION_CRITICAL state;
  - HOME cannot hold a sole authoritative copy;
  - production authoritative state cannot depend only on HOME storage;
- authoritative replication plans must span distinct failure domains when replication factor > 1;
- locality is an advisory preference only after hard storage policy passes;
- copy-plan integrity is hash bound.

Offline acceptance covered:

- HOME production-authority rejection;
- HOME cache/rebuildable allowance;
- distinct failure-domain requirement;
- valid replicated authoritative copy plan;
- stale storage snapshot rejection.

Still runtime-dependent:

- Home NAS discovery/enrollment;
- real storage reads/writes;
- checksums;
- backup/restore;
- live copy replication;
- measured RPO/RTO;
- physical unplug/reconnect acceptance.

## Phase 37 — Failure Domains and Resilience

Added `lib/resources/resilience.ts`.

Version:

`RESILIENCE_CONTRACT_VERSION = 1.0.0`

Implemented:

- failure-domain kinds:
  - host;
  - rack;
  - site;
  - HOME;
  - region;
  - provider;
  - partner DC;
- health and circuit-breaker snapshots;
- health-based new-work admission;
- ability to preserve existing work when degradation policy allows;
- drain state machine:
  - draining;
  - drained;
  - cancelled;
- failover plans bind:
  - source/target;
  - correlated failure-domain sets;
  - retry/checkpoint behavior;
  - reason;
  - temporary cost impact;
  - independent-verification requirement;
- failover target must escape the correlated source failure domains;
- non-retryable/non-checkpoint-aware work cannot be auto-failed-over;
- failover state machine:
  - proposed;
  - authorized;
  - dispatching;
  - verifying;
  - verified;
  - failed/cancelled;
- provider/dispatch evidence is insufficient to claim recovery;
- authoritative recovery requires:
  - verification receipt;
  - verification receipt hash;
  - healthy post-failover state.

Offline acceptance covered:

- degraded domain stops new placement;
- circuit-open domain blocks admission;
- drain preserves running work until zero;
- same-failure-domain failover rejection;
- provider acceptance cannot claim recovery;
- verified recovery requires evidence + healthy target state.

Still runtime-dependent:

- real failure-domain telemetry;
- live drain;
- live reroute/burst/fallback;
- checkpoint restore;
- production cost impact measurement;
- real post-failover health verification.

## Phase 38 — Resource Adapter SDK

Added:

- `lib/resources/adapter-sdk.ts`
- `lib/resources/development-mock-resource-adapter.ts`

Version:

`RESOURCE_ADAPTER_SDK_CONTRACT_VERSION = 1.0.0`

Provider-neutral operations:

- metadata;
- discover;
- authenticate;
- capabilities;
- health;
- capacity;
- cost;
- reserve;
- allocate;
- dispatch;
- status;
- cancel;
- release.

All adapter returns are typed `ResourceAdapterEvidence<T>` with:

`authoritative: false`

Provider results remain evidence and cannot establish:

- Job truth;
- resource trust;
- policy;
- verification truth;
- final placement success.

Added `assertResourceAdapterConformance` plus a DEVELOPMENT-only mock adapter.

Architecture matrix prevents resource adapters from importing authorization, Job service, policy-engine authority, credential broker authority, or business execution modules.

Offline acceptance covered:

- mock provider passes provider-neutral conformance;
- adapter evidence remains non-authoritative;
- forged authority claim is rejected;
- provider/context mismatch is rejected;
- DEVELOPMENT mock fails outside development.

Still runtime-dependent:

- real second provider;
- real authentication;
- real provider callbacks;
- provider capacity/cost feeds;
- real dispatch/release;
- scheduler/provider integration.

## Phase 39 — Governed aggregate ResourcePool

Added `lib/resources/pools.ts`.

Version:

`RESOURCE_POOL_CONTRACT_VERSION = 1.0.0`

Implemented:

- aggregate governed pool identity;
- company/portfolio scope;
- provider + adapter binding;
- lifecycle state;
- environments;
- capability classes;
- data classes;
- reliability;
- region;
- failure domains;
- credential-binding references;
- policy-binding references;
- auto-scheduling flag;
- aggregate capacity snapshots:
  - total;
  - used;
  - reserved;
  - protected headroom;
  - optional quota;
  - current workloads;
- capacity invariant:
  `used + reserved + protected headroom <= total`;
- readiness evidence:
  - identity;
  - adapter authentication;
  - validated capabilities;
  - verified health;
  - verified aggregate capacity;
  - failure-domain evidence;
  - cost model;
  - credential scope;
  - policy binding;
- trusted-scope/environment/data/capability checks before scheduling;
- concise owner-facing read model:
  - health;
  - utilization;
  - total capacity;
  - protected headroom;
  - workload count;
  - cost summary;
  - location/region;
  - reliability;
  - data policy;
  - environments;
  - auto scheduling.

No underlying per-server enrollment is required by this deterministic model.

Offline acceptance covered:

- incomplete governance prevents READY;
- capacity/quota/headroom invariants;
- cross-company rejection;
- data-class restriction;
- concise aggregate read model;
- stale capacity rejection.

Still runtime-dependent:

- real partner/colo onboarding;
- aggregate provider discovery;
- live quotas/costs;
- scoped production credentials;
- real health/capacity/workload feeds.

## Phase 44 — Deterministic adversarial harness

Added `lib/security/phase44-adversarial-harness.ts`.

Version:

`PHASE44_DETERMINISTIC_HARNESS_VERSION = 1.0.0`

The offline blocking matrix includes:

1. voice approval bypass;
2. staging → production scope misuse;
3. forged resource capability;
4. reservation replay;
5. scheduler/final-admission bypass;
6. provider-success spoofing;
7. credential scope escalation;
8. cross-company contamination;
9. release-registry tampering;
10. model/provider authority attempt.

Expected attack dispositions are typed as:

- rejected;
- idempotent-no-escalation;
- accepted-as-non-authoritative-evidence.

The tests exercise existing real deterministic contracts:

- Phase 42 voice intent integrity;
- Phase 29 credential broker;
- Phase 30 privileged capability validation;
- Phase 33 reservation idempotency;
- Phase 34 final dispatch admission;
- Phase 20 adapter non-authority;
- Phase 39 tenant-scoped pool admission;
- Phase 41 release-registry integrity;
- Phase 13 strict AI output-schema validation.

This is not the full canonical Phase 44 PASS.

Still required later:

- actual OpenRouter/provider swap/outage/rate-limit tests;
- real Pi enrollment/unplug/reconnect;
- real Home NAS test;
- real partner/DC pool test;
- measured cost optimization outcome;
- real provider/DC degradation/failover;
- forged live heartbeat/capacity callback tests;
- phone-off cloud continuity;
- backups/restore;
- production observability/alerts;
- real environment isolation;
- full release gate simultaneously green.

## Architecture / quality integration

Updated:

- `architecture/dependency-boundaries.json` → schema 1.1.0
- `architecture/coverage-policy.json` → schema 1.1.0

New critical modules are coverage-gated:

- storage-fabric;
- resilience;
- Resource Adapter SDK;
- ResourcePool;
- Phase 44 harness.

Contract-version drift tracking is enabled for all five contracts through `release/version-registry.json`.

## Phase 41 release-truth extension

Machine-readable versions now advance to:

- registry schema: 1.3.0;
- environment manifest schema: 1.3.0;
- release manifest schema: 1.3.0.

The registry now distinguishes deterministic contract availability from live runtime connection for:

- storage runtime;
- failover runtime;
- second Resource Adapter/provider;
- partner/DC pool runtime;
- Phase 44 deterministic harness vs full production acceptance.

All real runtime flags remain fail-closed:

- storage runtime: not-connected;
- failover runtime: not-connected;
- second provider: not-connected;
- partner pool runtime: not-connected;
- Phase 44 production acceptance: not-run.

## Remaining drift

No intended architecture drift is introduced.

The remaining gaps are live/provider/hardware acceptance gaps:

- Phase 2/3 real auth/database/RLS;
- Phase 4 real integrations;
- Phase 13 live OpenRouter/provider adapter/canaries;
- Phase 19 real durable queue/store/workers;
- Phase 20 real business adapters;
- Phase 21 real software deployment executor;
- Phase 28 real Pi/Linux agent;
- Phase 29 production secret backend;
- Phase 30 live telemetry;
- Phase 33 transactional persistence;
- Phase 34 live dispatch/probes/recovery/Job bridge;
- Phase 35 live billing/usage;
- Phase 36 real Home NAS/storage runtime;
- Phase 37 real failover runtime;
- Phase 38 real second provider;
- Phase 39 real partner/DC pool;
- Phase 40 durable historical analytics/calibration;
- Phase 42 live speech/native iPhone transport;
- Phase 43 optional Watch;
- Phase 44 full production end-to-end acceptance.

Deterministic implementation is not canonical production PASS where the master plan requires live evidence.
