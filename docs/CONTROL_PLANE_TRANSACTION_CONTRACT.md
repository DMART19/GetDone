# Universal Control-Plane Transaction Contract

GetDone now defines `ControlPlaneTransactionManager<TStores>` as the persistence boundary for authoritative state changes.

A production persistence adapter must execute the complete command callback inside **one real database transaction**.

For a consequential transition, the transaction owns:

1. atomic idempotency claim/check;
2. authoritative entity read under trusted scope;
3. optimistic version validation;
4. state mutation;
5. audit append;
6. idempotency completion with the authoritative result.

If any required write fails, all writes from that command must roll back together.

This prevents partial authority states such as:

- entity changed but audit missing;
- entity changed but idempotency still IN_PROGRESS;
- idempotency COMPLETED while state mutation rolled back;
- duplicate concurrent commands both creating effects.

The current repository provides the deterministic contract and in-memory/test implementations. Canonical production completion still requires a real database adapter that preserves these semantics with native transactions/unique constraints.

The older Decision-specific transaction layer is retained as a typed alias over the universal transaction manager so Decision behavior remains compatible with the same authority model.
