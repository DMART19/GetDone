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
- Phase 22 verification requests, evidence, strategy results, hash-bound receipts, freshness/expiry, independence rules, and authoritative verification transitions
- Task / Job / Outcome truth transitions bound to verification receipts
- Phase 23 advisory operational memory with Fact, Lesson, Experiment, Observation, OutcomeReference, confidence, sample size, confounders, expiry, supersession, relevance selection, and strict company isolation
- Phase 26 authoritative Resource Registry vocabulary, evidence records, readiness evaluation, lifecycle service, and concise read models
- Phase 27 deterministic Resource Enrollment workflow with hashed one-time challenges, expiry/replay protection, scope preservation, restart/cancel semantics, evidence, and lifecycle audit

## Not yet production-complete

The repository does **not** claim production autonomy yet. Canonical acceptance still requires real infrastructure for:

- production authentication/session persistence
- authoritative database transactions, migrations, and RLS
- live AI Gateway / OpenRouter routing and canaries
- durable distributed queue, worker leases, schedules, and crash recovery
- real business/software action adapters and deployment execution
- real Resource Fabric agent/hardware enrollment
- secrets/credential broker
- live profiling/telemetry
- placement, reservations, scheduler, capacity ledger, and failover
- production push/mobile delivery
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
- `docs/ASTRA_HANDOFF.md`

No phase is complete merely because code exists. Canonical PASS still requires the acceptance evidence specified by the master build plan.
