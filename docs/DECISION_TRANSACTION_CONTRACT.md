# Decision Transaction Contract

Decision resolution is intentionally expressed through `DecisionTransactionManager`.

A production persistence adapter must execute the following writes inside **one database transaction**:

1. Claim/check the idempotency key.
2. Read the authoritative decision under trusted tenant scope.
3. Perform optimistic version validation.
4. Persist the new decision state.
5. Append the audit event.
6. Mark the idempotency record completed with the authoritative result.

If any of steps 3–6 fail, the transaction must roll back all of them.

This prevents states such as:

- decision = approved but audit missing;
- decision = approved but idempotency still in-progress;
- idempotency = completed while the decision mutation rolled back.

The in-memory unit test implementation stages all three stores and commits them only after the transaction callback succeeds. The future Postgres/Supabase adapter must preserve the same semantics using a real database transaction/RPC/function rather than three independent HTTP writes.

This contract does not itself select a database and therefore does not mark canonical persistence phases PASS.
