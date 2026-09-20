# GetDone — UFO v2

GetDone is an iPhone-first owner control surface for a governed autonomous execution system. The permanent owner navigation is intentionally small: **Chat · Decisions · Resources**.

The repository is now substantially beyond the original Phase 1 visual scaffold. It contains the mobile owner UI plus a deterministic, provider-neutral control-plane foundation for trusted scope, capabilities, policy, authorization, state transitions, planning, verification, operational memory, and Resource Fabric registry/enrollment contracts.

It is **not** yet a production autonomous runtime. Production authentication, authoritative database persistence/RLS, the live AI gateway, durable distributed workers, real resource agents, credential brokerage, scheduling, and production side-effect adapters still require real infrastructure and acceptance evidence.

## Authority rule

**AI thinks. GetDone authorizes. Workers execute. Resources supply capacity. Verification establishes truth.**

The frontend, AI models, providers, workers, and resources are not sources of execution authority. Consequential work must remain server-scoped, policy-checked, authorized, idempotent, auditable, and independently verified.

## Implemented foundation

- iPhone-first Chat / Decisions / Resources owner surface
- provider-neutral Control API contracts and typed errors
- trusted execution scope and tenant/tampering guards
- authentication/session/step-up interfaces
- typed capability registry and runtime schemas
- objectives, guardrails, budgets, kill switches, and protected-capacity checks
- authoritative Goal / Plan / Decision / Approval / Task / Job / Outcome / Event transitions
- transactional audit/idempotency contracts
- hash-bound validation receipts, policy snapshots, approval proofs, authorization grants, and authorization consumption
- deterministic plan validation, policy classification, task generation, and DAG compilation
- signal bus, deterministic sensing, investigations, research contracts, and bounded context assembly
- Phase 22 verification requests/evidence/receipts with freshness, independence, uncertainty, and integrity binding
- Phase 23 advisory operational memory with strict company isolation, expiry, supersession, relevance, and context integration
- Phase 26 Resource Registry domain/service contracts with identity, trust, health, capability, location, cost, provider, and READY evidence gates
- Phase 27 deterministic resource enrollment workflow with hashed one-time token/challenge material, expiry, replay resistance, restart semantics, evidence, and audit transitions
- CI gates for runtime verification, secret scan, typecheck, lint, unit tests, and production build

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
- `/sign-in` — sign-in visual shell; production auth is not yet connected
- `/offline` — explicit offline state
- `/api/health` — service health
- `/api/dev/resources` and `/api/dev/decisions` — development-only seed reads, hard-locked outside allowed development runtime

## Before continuing implementation

Read:

- `docs/GetDone_UFO_v2_MASTER_BUILD_PLAN.md`
- `docs/SOL_IMPLEMENTATION_STATUS.md`
- `docs/SOL_20_AUTHORITY_HARDENING_REPORT.md`
- `docs/SOL_PHASE_22_23_26_27_REPORT.md`
- `docs/ASTRA_HANDOFF.md`

Do not rebuild deterministic authority contracts that already exist. Extend them behind real infrastructure adapters and preserve the authority model.
