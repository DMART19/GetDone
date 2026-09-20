# GetDone — UFO v2

GetDone is an iPhone-first owner control surface for a governed autonomous execution system. The permanent owner navigation remains intentionally small: **Chat · Decisions · Resources**.

The repository is now substantially beyond the original Phase 1 visual scaffold. It contains the mobile owner surface plus a deterministic control-plane foundation for scope, capability, planning, policy, authorization, verification, operational memory, resource registry, and resource enrollment.

## Authority rule

**AI thinks. GetDone authorizes. Workers execute. Resources supply capacity. Verification establishes truth.**

The frontend, AI providers, workers, resource agents, callbacks, and infrastructure providers are never execution authority by themselves.

## Implemented deterministic foundation

Current code includes:

- iPhone-first Chat / Decisions / Resources owner surface
- typed Control API envelopes and runtime validation
- trusted execution scope and tenant tampering guards
- authentication/session/step-up contracts
- capability registry with runtime input/output schemas
- objectives, guardrails, budgets, kill switches, and protected capacity
- authoritative Goal / Plan / Decision / Approval / Task / Job / Outcome / Event transitions
- atomic control-plane transaction and idempotency contracts
- Plan/step hashes, validation receipts, policy snapshots, authorization grants, approval proofs, and authorization-consumption records
- deterministic signals, sensing, investigations, research, and bounded context assembly
- deterministic Plan validation, policy classification, Task generation, and DAG compilation
- Phase 22 verification requests, evidence, strategy results, hash-bound receipts, freshness/expiry, authoritative verifier-source bindings/trust attestations, independence rules, and authoritative verification transitions
- Task / Job / Outcome truth transitions bound to verification receipts
- Phase 23 advisory operational memory with Fact, Lesson, Experiment, Observation, OutcomeReference, confidence, sample size, confounders, expiry, supersession, relevance selection, and strict company isolation
- Phase 24 attributed portfolio executive summaries plus automated adversarial security boundaries for auth, tenancy, callbacks, credentials, context contamination, external authority claims, kill switches, production promotion, and future Resource Fabric spoof/replay cases
- Phase 25 PWA/mobile foundation with standalone manifest, offline-only service-worker shell caching, redacted push presentation, safe deep links, explicit update/reconnect signaling, deterministic notification routing, and WebAuthn origin/RP/user-verification checks
- Phase 26 authoritative Resource Registry vocabulary, evidence records, readiness evaluation, lifecycle service, and concise read models
- Phase 27 deterministic Resource Enrollment workflow with hashed one-time challenges, expiry/replay protection, scope preservation, restart/cancel semantics, evidence, and lifecycle audit
- Phase 29 deterministic secret references, credential bindings, minimum-scope credential leases, expiry/revocation, secure-delivery references, and credential usage audit contracts
- Phase 30 deterministic resource profiling, independently validated privileged capabilities, authenticated telemetry health summarization, and a zero-side-effect resource telemetry simulator
- Phase 31 deterministic resource/data placement policy with HOME/customer-data/critical-copy defaults, encryption, region, reliability, fallback, interruption, and workload hard constraints
- Phase 32 control-plane-only placement requests, active idempotency reuse, snapshot-bound candidate evaluation, full rejection reasons, and explainable eligibility without reservation or dispatch
- Phase 33 deterministic resource/pool capacity ledgers, CAS-bound atomic reservation commit envelopes, scoped idempotency, leases/renewal/expiry, requested-vs-granted capacity, protected headroom, cancellation/release, pending allocation records, and exactly-once deterministic capacity restoration
- Phase 34 deterministic scheduler/dispatch foundation with Phase-35-governed eligible-only ranking, hash-bound placement decisions, retry/fallback lineage, live Phase-33 reservation gating, Phase-29 credential binding, short-lived final dispatch-admission receipts, trusted independent start/completion verification, explainable audit records, and release through Phase 33
- Phase 35 deterministic cost/capacity governor with owned/committed/reserved/spot/on-demand economics, protected headroom, quotas, budget caps/approval thresholds, eligible-only economic ranking, and estimate-vs-actual reconciliation
- Phase 40 full zero-side-effect resource policy simulator with historical-vs-projection labeling, policy/economic/scheduler/guardrail simulation, uncertainty, AI Gateway model-evidence recording, and explicit no-mutation/no-reservation/no-dispatch/no-secret-lookup guarantees

## Not yet production-complete

The repository does **not** claim production autonomy yet. Canonical acceptance still requires real infrastructure for:

- production authentication/session persistence
- authoritative database transactions, migrations, and RLS
- live AI Gateway / OpenRouter routing and canaries
- durable distributed queue, worker leases, schedules, and crash recovery
- real business/software action adapters and deployment execution
- real Resource Fabric agent/hardware enrollment
- production secret backend/token exchange and secure credential delivery transport
- live authenticated hardware profiling/telemetry and Resource Fabric signal emission
- durable transactional persistence for Phase 33 reservation/CAS commits plus live resource-adapter dispatch, production start/completion probes, scheduler persistence/recovery, failover, and measured economic execution
- production historical placement/cost/AI-route analytics stores and simulation evidence persistence
- production push subscription/delivery provider and notification persistence
- cryptographic WebAuthn/passkey verification through a real auth provider
- end-to-end production acceptance evidence

Deterministic contracts and unit tests are intentionally built ahead of those integrations so later agents consume the existing authority model rather than replacing it.

## Run locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Verify

```bash
npm run verify:runtime
npm run verify:secrets
npm run verify:architecture
npm run typecheck
npm run lint
npm test
npm run build
```

## Current owner routes

- `/` — Home / Chat shell
- `/decisions` — unified decision queue
- `/decisions/[id]` — development decision detail
- `/resources` — resource overview
- `/resources/add` — add-resource visual flow
- `/resources/[id]` — resource detail
- `/sign-in` — sign-in visual shell
- `/offline` — explicit offline state
- `/api/health` — service capability/connection health
- `/api/dev/resources` and `/api/dev/decisions` — development-only seed reads, hard-disabled in production

## Read before continuing

Use these as the implementation source of truth:

- `docs/GetDone_UFO_v2_MASTER_BUILD_PLAN.md`
- `docs/SOL_IMPLEMENTATION_STATUS.md`
- `docs/SOL_20_AUTHORITY_HARDENING_REPORT.md`
- `docs/SOL_PHASE_22_23_26_27_REPORT.md`
- `docs/SOL_PHASE_24_25_REPORT.md`
- `docs/SOL_PHASE_29_32_REPORT.md`
- `docs/SOL_PHASE_33_REPORT.md`
- `docs/SOL_PHASE_34_REPORT.md`
- `docs/SOL_PHASE_35_40_REPORT.md`
- `docs/SOL_ARCHITECTURE_INTEGRITY_REPORT.md`
- `docs/ASTRA_HANDOFF.md`

No phase is complete merely because code exists. Canonical PASS still requires the acceptance evidence specified by the master build plan.
