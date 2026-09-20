# Sol 20 — Deterministic Authority Hardening Report

This report records the 20 requested GetDone upgrades implemented by GPT-5.6 Sol. It distinguishes deterministic repository work from infrastructure that still requires a real database/auth/runtime.

## 1. Reproducible repository / CI foundation — IMPLEMENTED

- committed `package-lock.json`
- exact top-level dependency versions
- Node 24 runtime requirement
- exact npm version sourced from `packageManager`
- CI uses `npm ci`
- CI preserves: runtime verification -> secret scan -> typecheck -> lint -> tests -> production build
- CI is read-only and no longer mutates the repository to bootstrap a lockfile

## 2. Server-only runtime environment authority — IMPLEMENTED

- `GETDONE_RUNTIME_ENV` is the server-authoritative environment
- missing/invalid values fail closed
- `NEXT_PUBLIC_APP_ENV` remains UI-only and grants no authority

## 3. Production hard-lock for development APIs — IMPLEMENTED

- development APIs require non-production runtime, non-production `NODE_ENV`, and explicit development seed mode
- production runtime or production Node execution disables development API access
- tests cover the lockout behavior

## 4. Trusted Execution Scope — IMPLEMENTED

Canonical scope:

`user -> portfolio -> company -> environment -> optional resource`

The scope is server-derived and immutable at the authority boundary.

## 5–7. Capability Invocation Envelope / authority stripping / scope chain — IMPLEMENTED

- capability execution uses a trusted envelope
- authoritative company/environment/resource/data fields are rebound from trusted context
- conflicting payload authority is rejected
- autonomous invocation can enforce:
  `request scope = plan scope = task scope = invocation scope`
- adversarial tests cover portfolio/company/environment/resource drift

## 8. Capability Registry version/hash — IMPLEMENTED

- registry version
- registry content hash
- per-capability schema version
- authority-binding metadata

Plans, receipts, policy snapshots, grants, and future execution infrastructure can bind to the registry version/hash.

## 9–13. Universal atomic control-plane command layer — IMPLEMENTED AS A PERSISTENCE CONTRACT

Added:

- `ControlPlaneTransactionManager`
- `ControlPlaneTransaction`
- `AuthoritativeCommandEnvelope`
- atomic idempotency claim semantics
- atomic transition helper for entity state + audit + idempotency

Goal, Plan, Approval, Task, Job, Outcome, and Decision services now depend on transactional authority boundaries rather than performing independent state/audit writes.

A production database adapter must implement `run(...)` using a real DB transaction. The repository does not claim that database integration exists yet.

Idempotency states:
- CREATED
- IN_PROGRESS
- COMPLETED
- FAILED
- CONFLICT

## 14. Plan hash + Plan-step hash — IMPLEMENTED

Canonical SHA-256 hashes bind authorization to the exact proposal and exact step.

Mutating an authorized Plan or step changes its hash and invalidates downstream authority.

## 15. Policy Snapshot — IMPLEMENTED

The immutable snapshot records:

- policy version
- trusted scope
- plan/step hashes
- capability set
- capability-registry version/hash
- environment/data/region rules
- complete kill-switch input
- budget/guardrail state
- credential binding references/availability
- protected-headroom state
- fallback state
- resource-requirement hash
- idempotency identifier
- snapshot hash

## 16. Authorization Grant — IMPLEMENTED

Authorization grants bind:

- trusted scope
- Plan ID/hash
- step ID/hash
- capability set
- validation receipt
- policy snapshot
- Decision/Approval proof when required
- actor
- issue/expiry time
- step-up proof when required
- grant integrity hash

Grants cannot be issued for a scope that does not match the Plan.

## 17. Step-Up Proof + Approval Proof — IMPLEMENTED

Trusted booleans are no longer the new approval contract.

Added proof structures containing:
- actor
- trusted scope
- authentication/approval timestamps
- expiry
- Plan/step hashes
- Decision/Approval references
- step-up method/reference

Strong approval requires a matching, fresh step-up proof.

Decision and Approval service paths now accept proof objects rather than `stepUpSatisfied: true`.

## 18. Multi-capability step policy aggregation — IMPLEMENTED

Every requested capability is evaluated deterministically.

Precedence:

`BLOCKED > STRONG_APPROVAL > APPROVAL_REQUIRED > AUTO`

A sensitive capability raises the authority requirement for the complete step.

## 19. Full admission / kill-switch evaluation — IMPLEMENTED

Policy evaluation can include:

- global
- portfolio
- company
- integration
- capability
- resource
- pool
- provider
- failure domain
- workload class

It also evaluates:
- environment
- data class
- region
- credential bindings
- protected headroom
- fallback
- idempotency
- budgets
- guardrails
- approval/step-up proofs

## 20. Validation Receipt -> Policy Snapshot -> Authorization Grant -> Task — IMPLEMENTED

New deterministic authority chain:

```text
Plan
  -> Plan/step hashes
  -> Validation Snapshot
  -> Validation Receipt
  -> Policy Snapshot
  -> Step Policy Evaluation
  -> Authorization Grant
  -> Generated Task
```

A Validation Receipt contains:
- Plan ID/hash
- all step hashes
- validation status
- errors/warnings/owner decisions
- ordered steps
- total estimated step cost
- validation snapshot
- registry version/hash
- validation/expiry time
- receipt hash

Task generation rejects:
- arbitrary `{ status: "valid" }` objects
- expired receipts
- receipt integrity changes
- mutated Plans/steps
- missing grants
- expired grants
- grant integrity changes
- grant/Plan scope mismatches
- grant/receipt hash mismatches
- paused/completed objective work

Generated tasks preserve:
- trusted user/portfolio/company/environment/resource scope
- validation receipt ID/hash
- policy snapshot ID/hash
- authorization grant ID/hash
- derived immutable authorization lineage

## What remains intentionally outside this upgrade

These 20 upgrades strengthen deterministic authority. They do not claim completion of:

- production database transactions
- real auth/passkey provider
- durable cloud job queues/workers
- Phase 13 live AI/OpenRouter routing
- real credential broker
- resource placement/scheduling
- production action adapters

Those systems should implement and consume these contracts rather than redefine them.
