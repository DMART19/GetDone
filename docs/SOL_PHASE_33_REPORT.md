# Sol Phase 33 Deterministic Reservation and Capacity-Ledger Report

This report records the GPT-5.6 Sol deterministic tranche for Phase 33. It deliberately separates deterministic concurrency contracts from production transactional acceptance.

## Implemented domain

### Capacity ledgers

Resource and pool targets use the same ledger model. Each ledger records:
- total capacity;
- committed capacity;
- reserved capacity;
- protected headroom;
- portfolio/company scope;
- target type/id;
- monotonic revision;
- update time;
- integrity hash.

A ledger is invalid when committed + reserved + protected headroom exceeds total capacity in any dimension.

### Reservation authority

Reservation creation requires control-plane authority bound to:
- authorized Job;
- Placement Request;
- Placement Decision;
- Placement Decision hash;
- exact selected resource/pool target;
- portfolio/company scope.

Provider/frontend/model assertions cannot create reservation authority.

### Requested versus granted capacity

Reservation records retain both requested and granted vectors. The deterministic default is full grant. A partial grant is rejected unless the control plane explicitly marks partial grant authorization.

### Atomic concurrency contract

Every non-replay mutation produces an `AtomicReservationCommit` containing:
- transaction ID and operation;
- scoped idempotency key;
- ledger ID;
- expected ledger revision and current ledger hash;
- next ledger revision and hash;
- expected current reservation hash for renew/release/cancel/expire;
- next reservation hash;
- full next ledger/reservation records;
- commit integrity hash.

The production `AtomicReservationStore` contract requires a single atomic persistence transaction that:
1. verifies ledger revision/hash;
2. verifies current reservation hash for mutation operations;
3. enforces unique `portfolioId + companyId + idempotencyKey`;
4. writes next ledger and reservation together;
5. returns a conflict rather than automatically applying a stale write.

The deterministic tranche does not pretend that this interface is equivalent to a live database transaction.

## Lease lifecycle

Implemented:
- issuance and expiry;
- renewal only before expiry and only to a later expiry;
- explicit release;
- cancellation;
- expiry of abandoned/stale reservations;
- active state implies capacity is held;
- terminal state implies capacity is not held.

Renewal changes reservation/ledger revision without adding capacity again.

Release, cancel, and expire subtract exactly the granted capacity. Replaying the same terminal operation returns the existing terminal reservation without another ledger decrement.

## Idempotency

The logical request hash binds:
- job and placement lineage;
- selected target;
- requested capacity;
- granted capacity;
- partial-grant authorization;
- scoped idempotency key.

A true replay returns the prior reservation without another capacity mutation. Reusing the key with different logical requirements is rejected.

## Allocation boundary

Phase 33 can produce a hash-bound pending `AllocationRecord` only from a live, unexpired reservation for the same authorized Job. It contains reservation hash, target, and granted capacity lineage.

It does not:
- contact a provider;
- start a worker;
- change Job truth;
- perform Phase 34 dispatch.

## CI-safe concurrency acceptance

Unit tests prove the deterministic contract:
- two writers beginning from revision N cannot both commit when one has advanced the ledger to N+1;
- a refreshed second writer is still blocked when capacity/protected headroom is insufficient;
- replay does not consume capacity twice;
- release replay does not restore capacity twice;
- expired reservations cannot authorize dispatch/allocation;
- cancellation/release races fail as conflicting terminal transitions;
- commit envelope tampering is rejected.

## Canonical production boundary

Phase 33 deterministic contracts are implemented and CI-testable.

Canonical production PASS still requires:
- an authoritative database implementation of `AtomicReservationStore`;
- real atomic transactions/locking or serializable compare-and-swap semantics;
- multi-process concurrency tests against that database;
- durable reservation/idempotency records;
- lease reaper/sweeper behavior under crashes and restarts;
- production recovery evidence.

Phase 34 deterministic scheduler/dispatch/start-verification contracts were subsequently added in `docs/SOL_PHASE_34_REPORT.md`. Phase 33 production acceptance still requires a real transactional store before live Phase 34 dispatch can safely consume reservations.
