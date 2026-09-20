# GetDone Architecture Integrity Tranche

This tranche hardens composition across existing deterministic phases without introducing a parallel authority system.

## Findings that triggered the tranche

The repository still matched the master product model, but four seam risks remained:

1. verification independence was represented by a caller-supplied evidence independence key;
2. Phase 34 scheduler ranking consumed Phase 32 eligibility but did not require Phase 35 governor admission;
3. Phase 34 dispatch did not bind the Phase 29 credential lease;
4. there was no short-lived final dispatch admission artifact rechecking current kill switches and authority freshness immediately before adapter dispatch.

A documentation drift was also present: `docs/ARCHITECTURE.md` still described full service-worker/PWA delivery as deferred even though the deterministic Phase 25 foundation exists.

## Verification-source trust hardening

Added `lib/verification/source-trust.ts`.

`VerificationSourceBinding` is an authoritative registry contract for:
- portfolio/company/environment;
- source type and source ID;
- allowed verification strategies;
- authoritative independence domain;
- active/revoked/disabled state;
- validity/expiry;
- binding hash.

`VerificationTrustAttestation` rechecks a VERIFIED receipt against the actual evidence and registered source bindings.

A caller can still submit an evidence object, but it cannot choose its own trusted independence identity: `evidence.independenceKey` must equal the authoritative binding's independence domain. Evidence must also remain fresh at attestation time.

Phase 34 running/completion records now require the trust attestation hash in addition to the receipt hash.

## Phase 35 -> Phase 34 binding

Phase 35 reports now include `evaluatedAt` and `expiresAt`.

Phase 34 ranking requires a valid Phase 35 governor report for the same Placement Request.

Only `rankedAllowedCandidateIds` enter autonomous ranking.

`approvalRequiredCandidateIds` and `blockedCandidateIds` remain visible in the ranking report but cannot be selected autonomously.

Placement decisions bind `governorReportHash`, and the actual governor report is required when the decision is constructed.

## Phase 29 -> dispatch binding

Dispatch admission requires an active CredentialLease matching:
- portfolio/company/environment;
- Job;
- Placement Request;
- selected resource;
- provider;
- capability;
- credential expiry/status.

The final DispatchIntent records `credentialLeaseId` and `credentialLeaseHash`.

No raw secret is added to scheduler/dispatch contracts.

## Final dispatch admission receipt

`DispatchAdmissionReceipt` is a short-lived control-plane artifact created immediately before adapter dispatch.

It binds:
- placement/governor/decision hashes;
- Phase 33 reservation/allocation hashes;
- Phase 29 credential lease hash;
- provider/capability;
- current policy-registry version/hash;
- current kill-switch snapshot hash;
- READY resource state;
- target environment permission;
- admission/expiry time.

Creation fails when:
- resource is not READY or environment-authorized;
- reservation/allocation lineage is invalid or expired;
- governor no longer autonomously allows the resource or is stale;
- credential is inactive/stale/wrong scope/provider/capability;
- a current global/portfolio/company/capability/resource/provider kill switch blocks work.

Receipt expiry is capped by the earliest reservation, credential, governor, or local admission TTL.

## Architectural drift CI gate

Added `npm run verify:architecture` and wired it into GitHub Actions.

It currently protects:
- permanent Chat / Decisions / Resources owner navigation;
- README authority principle;
- model/provider SDK and direct endpoint isolation behind future `lib/ai-gateway`;
- no secret-like `NEXT_PUBLIC_*` configuration;
- development mock-data isolation behind the repository seam;
- zero-side-effect simulator isolation from reservation/scheduler/credential mutation modules;
- required Phase 34 governor/credential/admission/trusted-verifier/Job-truth markers;
- presence of verifier-source trust contracts;
- removal of stale Phase 25 architecture wording.

## Remaining drift after this tranche

No product-model drift was found in the permanent owner experience or authority principle.

Remaining differences from the canonical plan are implementation/runtime gaps rather than new contradictory architecture:

- deterministic Resource Fabric phases are ahead of the original runtime-first ordering;
- Phase 2/3 production auth/database/RLS remain unresolved;
- Phase 13 production AI Gateway is not connected;
- Phase 19 durable Job Engine is not connected;
- Phase 28 real Pi/Linux agent is not built;
- Phase 29 secret backend/token exchange is not connected;
- Phase 30 live telemetry is not connected;
- Phase 33 does not yet have real transactional persistence/multi-process concurrency proof;
- Phase 34 has no live adapters, independent production probes, durable recovery, or JobService integration;
- Phase 35 has no live billing/usage feeds;
- Phases 36-39 production storage/resilience/second-provider/DC work remain open;
- Phase 40 lacks production historical stores/calibration;
- Phase 41 deterministic release registry/manifest/manual generation is implemented; real production deployment evidence remains unavailable until the production infrastructure exists;
- Phase 42 deterministic voice intent/secure-handoff contracts and Phase-41 registry integration are implemented; live speech/native-iPhone transport and durable runtime persistence remain open.

Phase 41 now binds Git SHA, app/schema/database/policy/adapter/AI-routing/voice state, CI evidence, environment/deployment state, evidence documents, and operating manuals into reconstructable release artifacts. Phase 42 adds no new authority path: voice is constrained to typed evidence/query/initiation plus secure phone handoff. Remaining drift is infrastructure/runtime incompleteness rather than release-anatomy ambiguity.
