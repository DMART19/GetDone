# Dead-letter operator acceptance

Requirement 10 is implemented as an owner/admin-only operator surface over the authoritative Job runtime.

The operator can inspect the durable dead-letter record, retry schedule, runtime transactions, recovery records, execution outcomes/events, persisted execution-spec summary, provider execution records, verification evidence, and prior operator actions.

## Safe retry rule

A retry is a redrive, not a replay.

- The source Job must remain dead-lettered.
- A different authoritative replacement Job is required.
- The replacement Job must already be queued and carry intact Task authorization consumption.
- Its grant/consumption lineage must differ from the source Job.
- Production provider actions require a newly supplied credential lease reference.
- A new provider request ID and idempotency key are deterministically derived for the replacement lineage.
- The old provider operation ID is never dispatched again.
- A durable source-job redrive guard in the existing idempotency ledger permits only one replacement lineage, including crash/retry recovery of the operator request.
- Cancel uses the durable Job compare-and-swap path.
- Dismiss records an authoritative audit event without mutating provider state.

The UI is available at `/operations/dead-letters`, with an entry point from Resources.

PostgreSQL acceptance:

```bash
GETDONE_POSTGRES_INTEGRATION=true npx vitest run lib/execution/dead-letter-operator-postgres.integration.test.ts
```
