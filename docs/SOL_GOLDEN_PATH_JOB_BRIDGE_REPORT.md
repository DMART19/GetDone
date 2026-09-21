# Sol Cross-Phase Golden Path + Phase 34 -> JobService Bridge Report

This report records the deterministic composition and verified-execution bridge tranche.

## Status

**DETERMINISTIC COMPOSITION + JOB BRIDGE IMPLEMENTED; PRODUCTION PERSISTENCE/PROVIDER EXECUTION REMAINS UNCONNECTED**

This tranche does not claim production execution. Its purpose is to prove that the existing deterministic phases compose without weakening authority when connected together.

## Cross-phase golden-path harness

Added `lib/composition/golden-path-harness.ts`.

`runDeterministicGoldenPath()` executes the following path using deterministic in-process stores/adapters and fixed clocks:

`Objective -> Plan -> Validation -> Policy -> Decision -> Approval -> Task -> Job -> Placement -> Governor -> Reservation -> Credential admission -> Dispatch admission -> start verification -> Job running -> completion verification -> Outcome -> memory -> resource release`

The harness returns:
- `simulationOnly: true`;
- `productionExecutionClaimed: false`;
- one hash-bound stage result for each of the 19 stages;
- final authoritative/advisory state;
- a deterministic result hash.

The plan intentionally uses `compute.cpu.light`, which requires approval. The harness therefore proves a real Decision/Approval seam rather than using an AUTO-only capability.

The composition uses existing production-shaped deterministic primitives rather than replacing them:
- Objective conflict/active checks;
- Plan construction;
- Plan validator attestation and validation receipt;
- policy engine and protected-capacity evidence;
- Decision service;
- Approval service and approval proof;
- Authorization Grant;
- TaskGenerator;
- JobService;
- Phase 32 placement;
- Phase 35 governor;
- Phase 34 scheduler;
- Phase 33 reservation/allocation/release;
- Phase 29 credential lease;
- Phase 34 dispatch admission;
- Phase 22 independent verification/source trust;
- OutcomeService;
- Phase 23 advisory memory.

Tests run the full path repeatedly and require identical stage artifacts/result hash.

## Composition bug found and fixed

The first golden-path run found a real cross-phase clock inconsistency.

ApprovalService accepted an injected deterministic clock for transition/proof creation, but the internal `assertApprovalProof` / `assertStepUpProof` calls still defaulted to wall-clock time. A proof generated correctly inside a historical deterministic simulation was therefore immediately considered expired by the next line of the same service.

The service now uses one authoritative injected clock consistently for:
- proof creation;
- step-up validation;
- approval-proof validation;
- state transition/idempotency time.

The production default remains `() => new Date()`.

Decision transitions and the common transition helper also expose optional clocks with unchanged production defaults, enabling deterministic cross-phase verification without rewriting authority logic.

## Phase 34 -> JobService verified-start bridge

Added `lib/domain/services/job-execution-bridge.ts`.

Contract version:

`JOB_EXECUTION_BRIDGE_CONTRACT_VERSION = 1.0.0`

### Verified start fact

`JobVerifiedStartFact` is created only from an intact Phase 34 `VerifiedRunningPlacement`.

It binds:
- portfolio/company/environment;
- Job ID;
- verified running-placement ID/hash;
- placement decision ID/hash;
- reservation ID/hash;
- allocation ID/hash;
- start verification receipt ID/hash;
- start verification trust-attestation ID/hash;
- verification/issue/expiry time;
- fact hash.

It deliberately does **not** contain `providerOperationId`.

Provider ACCEPTED cannot be converted directly into Job start authority.

### Authoritative bridge store

`JobExecutionBridgeStore` is the persistence seam for:
- verified-start facts;
- verified-completion facts.

JobService loads the fact from this authoritative store. A caller-supplied object is not sufficient.

No in-memory implementation is claimed as production. The golden-path/testing store is simulation-only.

### Job claimed -> running

`JobService.start(id, command, verifiedStartFactId)` now requires:
- existing claimed worker;
- inherited authoritative Task authorization consumption;
- authoritative bridge store;
- persisted verified-start fact;
- exact Job/scope/environment binding;
- valid integrity hash;
- fresh issue/expiry window.

On success JobRecord persists:
- verified start fact ID/hash;
- verified running-placement ID/hash.

The transition event is:

`job-started-from-verified-resource-start`

The old provider-acceptance-only path is no longer sufficient.

### Completion -> Job verification

`JobVerifiedCompletionFact` is created only from:
- the same intact `VerifiedRunningPlacement`;
- an intact Phase 34 `VerifiedPlacementCompletion`;
- exact running-placement ID/hash lineage.

`JobService.beginVerification(id, command, verifiedCompletionFactId)` requires the persisted completion fact and checks it against the running-placement lineage already stored on the Job.

The transition event is:

`job-verification-started-from-verified-resource-completion`

Completion does **not** set Job success.

### Job success remains authoritative verification truth

The bridge can create:
- a Job verification request;
- Job execution verification evidence derived from the hash-bound verified-completion fact.

That evidence is resolved through the existing verification engine into an authoritative Job verification receipt.

Only then can existing `JobService.succeed(... receiptId)` transition Job to `succeeded`.

Therefore the authority chain is now:

`provider accepted -> independent resource-start verification -> VerifiedRunningPlacement -> persisted JobVerifiedStartFact -> Job running -> independent resource completion verification -> persisted JobVerifiedCompletionFact -> Job verification request/evidence -> authoritative Job verification receipt -> Job succeeded`

The provider/resource adapter never owns Job truth.

## Deterministic clock consistency

JobService now uses its injected clock for:
- verified-start fact freshness;
- verified-completion fact freshness;
- final verified Job receipt checks;
- uncertain Job receipt checks.

Default production behavior remains wall-clock time.

## Quality / drift gates

The new contracts are added to:
- the dependency-boundary matrix;
- control-plane module/test coverage policy;
- semantic contract-version drift tracking;
- Phase 41 release/version registry;
- environment manifest;
- generated release manifest/manual verification.

The composition harness is blocked from production UI/feature imports by the dependency matrix.

Release truth records:
- Job execution bridge contract: deterministic;
- live authoritative bridge store: not connected;
- golden-path harness: deterministic simulation only;
- production execution claimed: false.

## Remaining production work

This tranche closes the deterministic composition and Job-start authority seam, but canonical production PASS still requires:
- durable production `JobExecutionBridgeStore` persistence inside the real control-plane database/transaction model;
- real Phase 33 transactional reservation persistence;
- real ResourceDispatchAdapter implementations;
- real independent start/completion verifier collectors;
- real durable Job Engine/worker claims/leases/recovery;
- crash-safe atomic/recoverable ordering between verified placement facts and Job transitions;
- live credential broker backend/delivery;
- durable audit/evidence persistence;
- end-to-end staging/production Phase 44 acceptance.

Astra/runtime work should implement those live adapters against this bridge rather than restoring direct provider-to-Job transitions.
