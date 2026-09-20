# Sol Phase 29–32 Deterministic Resource Fabric Report

This report records the GPT-5.6 Sol deterministic tranche for Phases 29–32. It intentionally stops before infrastructure-dependent acceptance that requires a real secrets backend, node agent, persistent telemetry, concurrent database transactions, reservations, scheduler dispatch, or production hardware.

## Phase 29 — Secrets and Credential Broker

Implemented:
- SecretReference records contain backend references only, never raw secret values;
- CredentialBinding records bind provider/environment/company/capability/scope/resource/location authority;
- CredentialRequest is control-plane-only and bound to authorized job/placement/resource scope;
- CredentialLease grants exactly the requested subset of binding scopes;
- leases are hash-bound, TTL-bounded, expiring, revocable, and releasable;
- delivery is represented by an opaque secure-delivery reference rather than raw credential material;
- credential usage audit records are hash-bound;
- cross-company, staging-vs-production, HOME-vs-data-center, non-READY resource, expired, and over-broad requests fail closed.

Still deferred:
- real Vault/KMS/Secrets Manager backend;
- provider token exchange/OAuth refresh;
- encrypted material delivery to a real resource agent;
- durable issuance/revocation persistence;
- production OpenRouter credential exchange.

## Phase 30 — Resource Profiling, Capability Validation, and Telemetry

Implemented:
- normalized resource profile claims covering architecture, CPU, RAM, GPU/VRAM, disk, network, runtime/software, benchmark, latency, uptime, thermal, and power fields;
- independent hash-bound capability validation evidence;
- privileged GPU/production/authoritative-storage claims require independent evidence;
- fabricated GPU claims do not become validated profile authority;
- authenticated telemetry health summarization;
- stale/missing heartbeat behavior becomes UNREACHABLE;
- capacity/thermal thresholds produce deterministic DEGRADED/SATURATED health;
- unauthenticated telemetry is rejected as health authority;
- zero-side-effect simulator produces deterministic healthy/degraded/saturated/stale/heartbeat-loss scenarios for CI.

Still deferred:
- real Linux/Pi telemetry transport;
- hardware probes/attestation;
- persistent time-series store;
- live Signal Bus health/capacity transitions;
- hardware acceptance.

## Phase 31 — Resource Policy and Data Classification

Implemented:
- PUBLIC, INTERNAL, CUSTOMER, SENSITIVE, PRODUCTION_CRITICAL, REBUILDABLE, TEMPORARY, ARCHIVE, BACKUP, and MODEL_ARTIFACT classes;
- HOME, OFFICE, CLOUD, COLO, and PARTNER_DC location classes;
- hard constraints for environment, data class, location, region, reliability, encryption, fallback, interruption class, and workload allow/deny;
- default HOME deny for production CUSTOMER/SENSITIVE data unless explicitly authorized;
- default HOME deny for sole PRODUCTION_CRITICAL authoritative durable copy;
- preference hints remain non-authoritative and cannot override hard constraints;
- deterministic explainable reason codes.

## Phase 32 — Placement Request and Candidate Evaluation

Implemented:
- only authorized control-plane jobs may create placement requests;
- requests carry capability requirements, compute envelope, priority/deadline, checkpoint/retry properties, data class/regions/locality, reliability/fallback, max cost, optional pin/exclusions, idempotency key, authorization lineage, and expiry;
- request and candidate snapshots are hash-bound;
- active logical idempotency requests are reused; conflicting reuse fails;
- candidate evaluation order is fixed:
  scope -> policy -> health -> capability/profile -> capacity -> credential/environment -> cost;
- request-specific region/reliability/fallback constraints are enforced;
- stale/unhealthy/under-capacity/policy-forbidden/out-of-scope/credential-missing/over-budget candidates are rejected with explicit reasons;
- pinned resources still pass all hard constraints;
- eligible results carry snapshot lineage and deterministic explanations;
- no reservation, ranking, allocation, or dispatch exists in this tranche.

## Authority preservation

Resource agents and providers report evidence; they do not establish credential, health, policy, or placement authority. The frontend and models cannot create authoritative placement eligibility. Economics is evaluated only after hard security/reliability constraints pass.

## Canonical PASS boundary

Phases 29–32 now have deterministic contracts and CI-testable safety behavior. Phase 33 deterministic reservation/capacity-ledger contracts were subsequently added in `docs/SOL_PHASE_33_REPORT.md`. Canonical production acceptance still requires the real secret/token infrastructure, node/hardware telemetry, durable persistence, and live transactional multi-process reservation evidence.
