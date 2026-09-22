# GetDone Durable Job Worker Runbook

This runbook covers the cloud-MVP persistent Job worker. It deliberately does not implement or replace the advanced Resource Fabric scheduler/reservation architecture.

## Process separation

Deploy the same GetDone release as two independent services:

1. **Web / owner service**
   - normal Next.js owner and Control API traffic;
   - leave `GETDONE_PROCESS_ROLE=web`.

2. **Job worker service**
   - use `Dockerfile.worker`;
   - set `GETDONE_PROCESS_ROLE=job-worker`;
   - give it no public ingress;
   - expose only `/api/internal/jobs/worker-health` to trusted infrastructure;
   - use a unique `GETDONE_JOB_WORKER_ID` per process instance.

The worker process starts the persistent poll/recovery loop through Next.js instrumentation. Middleware denies ordinary owner/API traffic in the worker role.

## Required server-side configuration

```text
GETDONE_RUNTIME_ENV=staging|production
GETDONE_DATA_MODE=authoritative
DATABASE_URL=<PostgreSQL 16+ connection>
GETDONE_DB_SSL=true

GETDONE_PROCESS_ROLE=job-worker
GETDONE_JOB_WORKER_ID=<unique stable worker instance id>
GETDONE_INTERNAL_WORKER_TOKEN=<server-only random secret>

GETDONE_JOB_POLL_INTERVAL_MS=1000
GETDONE_JOB_ERROR_BACKOFF_MS=5000
GETDONE_JOB_RECOVERY_LIMIT=50
GETDONE_JOB_LEASE_SECONDS=60
GETDONE_JOB_HEARTBEAT_SECONDS=20
GETDONE_JOB_BATCH_SIZE=10
GETDONE_JOB_RETRY_BASE_DELAY_MS=1000
GETDONE_JOB_MAX_ATTEMPTS=5
GETDONE_JOB_RECOVERY_DELAY_MS=1000

GETDONE_HTTP_ACTIONS_JSON=<approved server-configured operations>
<authorization variables referenced by approved operations>
```

Never expose worker, database, provider, or authorization secrets through `NEXT_PUBLIC_*`.

## Startup gate

Before starting a worker against a target environment:

1. run `npm run db:migrate`;
2. confirm latest migration is `2026-09-22.3`;
3. run `npm run db:verify-production`;
4. confirm the target has current verified backup evidence;
5. configure the business-action operations that the worker is allowed to execute;
6. assign a unique worker ID.

## Runtime behavior

Each worker cycle:

1. recovers expired leases using Postgres row locking / `SKIP LOCKED`;
2. lists ready Jobs;
3. atomically claims a candidate using Job version + state hash;
4. persists the claim transaction and active lease;
5. re-reads the authoritative Job before any business side effect;
6. rejects stale Job snapshots, cancellation, tenant/scope drift, or authorization-consumption drift;
7. renews the active lease through persisted heartbeat transactions;
8. executes through the existing execution router / business-action orchestrator;
9. resumes a previously persisted provider operation by status polling rather than issuing the side effect again;
10. persists business verification evidence when produced;
11. releases, retries, cancels, or dead-letters through CAS-bound durable transactions.

Provider completion is not allowed to bypass GetDone's authoritative Job/verification rules.

## Health

Authorized infrastructure may query:

```http
GET /api/internal/jobs/worker-health
Authorization: Bearer <GETDONE_INTERNAL_WORKER_TOKEN>
```

The endpoint returns 200 only when the installed worker loop is running. A starting/degraded/stopped worker returns 503.

Worker liveness is also persisted in `job_worker_instances`.

## Failure behavior

- **Worker dies after claim:** lease expires; another worker recovers it.
- **Worker dies before provider side effect:** recovered retry may execute normally.
- **Provider operation already persisted:** replacement worker resumes provider status polling and does not issue a second provider operation.
- **Database outage:** worker enters degraded state and retries after error backoff.
- **Lease heartbeat failure / expiry:** stale lease cannot release authoritative runtime state.
- **Owner cancellation racing completion:** cancellation wins; worker cannot release over the cancelled durable state.
- **Max attempts exhausted:** work enters the dead-letter state.
- **Web service stops/restarts:** worker execution continues because state, leases, specs, provider lineage, outcomes, and evidence are in Postgres.

## Acceptance

The PostgreSQL Integration workflow exercises:

- two real OS worker processes racing one Job;
- atomic single-claim behavior;
- persisted heartbeat lineage;
- worker death after claim / before side effect;
- lease expiry + recovery;
- retry on another worker;
- max-attempt dead letter;
- provider-operation resume after runtime restart;
- no duplicate provider execution after persisted acceptance;
- owner cancellation racing worker completion;
- web/runtime object restart;
- PostgreSQL connection termination and pool recovery.

These tests are production-runtime implementation evidence. They do not by themselves prove that a staging or production worker deployment exists.

## Registry promotion rule

Keep these states unconnected until an actual deployed environment supplies live evidence:

- `execution.durableJobStoreStatus`
- `execution.persistentWorkerServiceStatus`
- environment `connections.durableJobEngine`
- database connection/readiness flags
- business-action adapter connection flags

Do not promote runtime connectivity merely because repository CI passes.
