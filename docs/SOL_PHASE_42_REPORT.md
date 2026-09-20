# Sol Phase 42 — Voice Intent and Secure Handoff

This report records the deterministic Phase 42 implementation.

## Goal

Voice is implemented as a low-friction query/workflow-initiation surface over the existing GetDone authority model.

It is not a new authority system.

The permanent rule remains:

**AI thinks. GetDone authorizes. Workers execute. Resources supply capacity. Verification establishes truth.**

For voice specifically:

**voice recognizes/proposes -> Control API scopes -> current policy evaluates -> secure phone flow handles approval/step-up/credentials -> existing workers execute -> verification establishes truth**

## Implemented contracts

Added `lib/voice/voice-intents.ts`.

Versioned constants:
- `VOICE_INTENT_CONTRACT_VERSION = 1.0.0`
- `VOICE_ADAPTER_CONTRACT_VERSION = 1.0.0`

Supported typed intents:
- `whats-important`
- `check-resources`
- `resource-health`
- `add-raspberry-pi`
- `drain-resource`
- `compute-usage`
- `provider-explanation`

These cover the canonical examples such as:
- What's important?
- Check my resources.
- How's DC West?
- Add my Raspberry Pi.
- Drain my home GPU.
- How much compute are we using?
- Why are we using provider X?

## Voice adapter boundary

`VoiceIntentAdapter` is a provider-neutral contract.

A future speech/NLU provider may return `VoiceAdapterCandidate` evidence containing:
- adapter ID/version;
- transcript SHA-256 only;
- confidence;
- typed intent;
- bounded typed slots.

The authoritative voice record does not store the raw transcript or raw audio.

The adapter does not supply trusted portfolio/company/environment/resource scope and does not supply policy authority. Trusted scope and the current policy-registry reference are injected server-side.

The live adapter is not implemented yet and is registered as:
- status: `not-connected`
- runtime adapter version: `UNIMPLEMENTED`
- speech provider: `UNCONFIGURED`

## Authority boundary

Every `VoiceIntentRecord` permanently records:
- `usesControlApi: true`;
- `usesCurrentPolicyRegistry: true`;
- `canApprove: false`;
- `canStepUp: false`;
- `canExecuteSideEffect: false`;
- `canAcceptRawCredentials: false`;
- strong approval handling: `secure-phone-only`;
- credential handling: `secure-provider-or-phone-only`.

Voice may therefore query or propose/initiate a workflow, but cannot establish approval, step-up, credential authority, policy truth, Job truth, placement truth, or execution truth.

## Secure handoff

The existing mobile deep-link contract now includes the allowlisted `resource-add` target.

Canonical sensitive/mutating examples:
- Add Raspberry Pi -> `/resources/add`
- Drain resource -> scoped Resource Detail handoff

The drain request may create a proposed workflow intent, but its voice record still has no execution or approval authority. Any approval/strong approval required by current policy continues through the existing Decisions/auth path.

## Credential and secret safety

Voice ingress validates exact fields and rejects credential-like keys/material.

Raw API keys, access/refresh tokens, passwords, secrets, authorization values, private keys, and Bearer-token-shaped values are not accepted into the typed authoritative voice contract.

Provider/device credential entry remains a secure provider/phone workflow.

## Scope and policy

Voice uses `TrustedExecutionScope` supplied by the server boundary.

A resource slot cannot override an already resource-scoped trusted context.

Each voice record binds the current `PolicyRegistryReference` and fails integrity validation if its Control API operation, policy reference, scope, authority flags, or other hash-bound fields are altered.

There is no second voice-specific policy engine.

## Audit

`createVoiceIntentAuditEvent` emits a scoped `voice.intent.accepted` audit event containing:
- correlation ID;
- trusted actor/scope/environment;
- typed intent;
- disposition;
- Control API operation;
- adapter/version;
- transcript hash;
- confidence;
- active policy version;
- secure-handoff flag.

The audit record contains no raw transcript or credential material.

## Release/version registry integration

Phase 41 has been extended to bind Phase 42.

Machine-readable schema evolution:
- version-registry schema: `1.1.0`;
- environment-manifest schema: `1.1.0`;
- generated release-manifest schema: `1.1.0`.

`release/version-registry.json` now records:
- voice intent schema/contract version;
- voice adapter-contract version;
- live voice-adapter status/version;
- speech-provider state;
- production-required flag;
- strong-approval handling;
- credential handling;
- exact source path/hash through generated release evidence.

`release/environment-manifest.json` now records voice state for development/staging/production:
- deterministic contract availability;
- live adapter connection state;
- strong approval allowed: false;
- raw credential input allowed: false;
- secure handoff target.

The generated operating manual now contains a Voice Intent and Secure Handoff section.

The generated machine manifest hashes the voice source and includes the complete registered voice release state.

## CI/adversarial coverage

Tests cover:
- all canonical read/query intents;
- secure Raspberry Pi setup handoff;
- drain-workflow initiation without execution/approval authority;
- raw credential/API-key/token rejection;
- resource-scope escalation rejection;
- authority-flag tampering;
- Control API operation/hash tampering;
- scoped audit generation without raw transcript/credential data;
- allowlisted add-resource deep links;
- release registry/environment bindings for voice.

Release verification fails if:
- voice contract versions drift from source constants;
- adapter-contract versions drift;
- live adapter state invents a version/provider;
- strong-approval/credential handling is weakened;
- environment voice authority changes;
- environment connection state contradicts voice adapter state;
- a production-ready release requires voice but has no connected voice adapter.

## What Phase 42 does not claim

This deterministic tranche does not claim:
- live microphone capture;
- speech-to-text provider integration;
- text-to-speech response delivery;
- Siri/App Intent/Shortcuts/native voice transport;
- live iOS provider handoff;
- production auth/session verification;
- live database persistence;
- production Decisions/step-up execution;
- live provider/device credential flow;
- durable voice-event storage;
- phone-off voice behavior.

Those remain runtime/platform integration work.

## Remaining drift after Phase 42

No new authority or product-model drift was found.

Remaining implementation/runtime gaps include:
- Phase 2/3 production auth/database/RLS and real migrations;
- Phase 13 live AI Gateway/OpenRouter routing;
- Phase 19 durable distributed Job Engine;
- Phase 20 real business action adapters;
- Phase 28 real Pi/Linux agent;
- Phase 29 production secret backend/token exchange;
- Phase 30 live authenticated telemetry;
- Phase 33 transactional reservation persistence and multi-process proof;
- Phase 34 live resource adapters/probes/recovery/JobService integration;
- Phase 35 live billing/usage feeds;
- Phases 36-39 production storage/resilience/second-provider/partner-DC work;
- Phase 40 production historical analytics/calibration;
- Phase 42 live speech/native iPhone voice adapter and runtime persistence;
- Phase 43 optional native Watch companion;
- Phase 44 complete adversarial/end-to-end production release gate.

Phase 42's deterministic authority and release-truth contracts are implemented without claiming the still-missing native/live voice runtime.
