# Queue saturation / backpressure acceptance

GetDone bounds queue growth and active execution at three layers.

- Queue admission uses a PostgreSQL transaction plus advisory lock so global and per-company pending-depth limits cannot be raced by concurrent enqueues. Saturation returns retryable `UNAVAILABLE` / HTTP 503 state with `QUEUE_SATURATED` details.
- Ready work is selected with a per-company `ROW_NUMBER()` rank, then ordered by rank before age, so every company receives a first slot before a noisy company receives its second slot.
- Each worker process executes at most `GETDONE_JOB_CONCURRENCY` Jobs simultaneously, and the value must not exceed `GETDONE_JOB_BATCH_SIZE`.
- Provider calls acquire expiring PostgreSQL permits keyed by business-action adapter ID. Permits are shared across worker processes, released after each provider call, and recovered after crashes by expiry.

Configuration:

```text
GETDONE_JOB_CONCURRENCY=4
GETDONE_JOB_QUEUE_DEPTH_LIMIT=1000
GETDONE_JOB_COMPANY_QUEUE_DEPTH_LIMIT=250
GETDONE_PROVIDER_CONCURRENCY_LIMIT=4
GETDONE_PROVIDER_CONCURRENCY_LEASE_SECONDS=120
GETDONE_PROVIDER_CONCURRENCY_LIMITS_JSON={}
```

Provider override keys are exact adapter IDs, for example:

```json
{"mail-adapter":2,"slack-adapter":4}
```

Real PostgreSQL acceptance proves that a noisy company cannot consume another company's queue capacity, fair selection surfaces another company before a second noisy-company job, worker active execution never exceeds its configured concurrency, provider saturation rejects excess calls, and released provider permits restore capacity.

Run:

```bash
GETDONE_POSTGRES_INTEGRATION=true npm run worker:test-backpressure
```

The existing worker crash/restart suite remains the exactly-once recovery authority for requirement 8.
