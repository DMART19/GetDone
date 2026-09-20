# Sol Authority Upgrade Report

This report records the deterministic backend work requested after the initial GetDone control-plane foundation.

## Completed

### Runtime capability contracts

- Added Zod runtime schemas for every currently registered capability.
- Capability input and provider output are validated before downstream use.
- Unknown/disabled capabilities still fail closed.
- Validation failures expose only normalized issue metadata, not raw sensitive payloads.

Covered capability contracts:
- revenue.read
- email.send
- repository.inspect
- production.deploy
- compute.cpu.light
- compute.gpu.inference
- storage.backup
- resource.health.read

### Deterministic budgets and guardrails

- Added hard budget limits.
- Added approval thresholds below the hard limit.
- Added projected-spend evaluation including reserved capacity/cost.
- Added deterministic min/max/equals/deny guardrail evaluation.
- Protected guardrail violations BLOCK.
- Non-protected violations require approval.
- Added disposition combination with BLOCKED taking precedence.

### Authoritative domain services

Added explicit services for:
- Goals
- Plans
- Approvals
- Tasks
- Jobs
- Outcomes

Services enforce:
- trusted portfolio/company scope
- optimistic version checks
- allowed state transitions
- audit events
- strong-approval step-up rules
- task authorization lineage
- worker claim requirement before job start
- independent verification evidence before task/job success
- evidence requirement before outcome verification

Durable queue leases, scheduler behavior, and resource placement remain intentionally deferred.

### Future-safe Resource Fabric domain contracts

Added non-scheduling types for:
- Resource
- ResourcePool
- PlacementRequest
- PlacementDecision
- Reservation
- Allocation
- Failover
- ResourceIncident

These define authoritative vocabulary without selecting resources or implementing scheduler authority.

### Callback/webhook verification

- Added HMAC-SHA256 verification using Node timing-safe comparison.
- Supports raw-body verification.
- Supports timestamp-bound signatures.
- Adds replay-window enforcement.
- Invalid/forged/stale callbacks fail closed.
- No provider callback can gain authority merely by supplying IDs in its payload.

### Atomic decision transaction contract

Decision resolution now depends on a `DecisionTransactionManager`.

A production persistence implementation must atomically commit:
1. idempotency claim/check
2. authoritative decision read/version check
3. decision state mutation
4. audit append
5. completed idempotency result

The unit-test transaction manager proves rollback semantics: if audit persistence fails, decision state and idempotency state remain unchanged.

See `docs/DECISION_TRANSACTION_CONTRACT.md`.

## Tests added/expanded

- capability input/output runtime validation
- hard budget and approval-threshold behavior
- protected/non-protected guardrails
- goal transition + audit
- strong approval step-up
- task success evidence
- job worker claim requirement
- outcome evidence requirement
- HMAC callback verification
- forged payload rejection
- replay-window rejection
- atomic decision commit
- idempotent decision retry
- rollback when audit persistence fails
- cross-company decision denial

## Still intentionally not claimed

This work does not make canonical persistence/auth phases PASS.

Still required later:
- production database
- real DB transaction implementation
- migrations/RLS
- real authentication/session provider
- durable cloud queue/worker leases
- AI Gateway/OpenRouter runtime
- Resource Fabric enrollment
- scheduler/placement authority
- credential broker
- real provider callbacks/adapters

The architecture is now prepared so those integrations can implement the established contracts rather than redefining authority.
