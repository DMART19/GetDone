# Worker crash / restart acceptance

This acceptance suite uses an isolated real PostgreSQL 16 database and separate OS worker processes.

For every scenario, the parent process:

1. migrates PostgreSQL,
2. persists an authoritative scoped Job, execution spec, and durable queue envelope,
3. launches a child worker process using the production DurableJobWorker, PersistentJobWorkerService, RoutedJobExecutionHandler, BusinessActionExecutionOrchestrator, and PostgreSQL stores,
4. waits until a durable crash boundary is reached,
5. sends SIGKILL,
6. starts a fresh worker process against the same database,
7. verifies provider-side-effect counters and durable Job transactions directly from PostgreSQL.

Covered crash boundaries:

- before provider dispatch,
- after provider acceptance but before verification,
- during provider verification,
- after retry scheduling is committed but before the worker returns,
- after provider completion/evidence persistence but before Job release.

The acceptance rule is side-effect exactly-once, not claim exactly-once. A recovered Job may have a new claim after an expired lease, but a consequential provider side effect must not be dispatched again once provider-operation lineage is durably persisted.

Run with:

```bash
GETDONE_POSTGRES_INTEGRATION=true npm run worker:test-crash-restart
```

The PostgreSQL Integration workflow runs this suite automatically.
