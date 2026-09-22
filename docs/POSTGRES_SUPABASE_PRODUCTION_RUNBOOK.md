# GetDone PostgreSQL / Supabase Production Runbook

This runbook is the canonical execution order for connecting GetDone's existing PostgreSQL persistence implementation to the existing Supabase Postgres target.

It does not authorize changing release-registry connection states merely because code or CI exists. Connection/readiness fields change only after the live target passes the production checks below.

## Preconditions

- Use the existing Supabase project selected for GetDone.
- PostgreSQL server major version must be 16 or newer.
- The database connection string is server-only and must never be committed.
- Preserve the existing plain-PostgreSQL adapter boundary. Do not introduce Supabase client SDK calls into domain or authority services.
- TLS verification remains enabled for staging/production. `GETDONE_DB_SSL=false` is allowed only for isolated local/CI Postgres.
- Development seed persistence must remain impossible in production runtime mode.

## Server-side configuration

Configure the deployment secret store with:

```text
GETDONE_RUNTIME_ENV=staging|production
GETDONE_DATA_MODE=authoritative
DATABASE_URL=<server-only Supabase PostgreSQL connection string>
GETDONE_DB_POOL_MAX=10
GETDONE_DB_STATEMENT_TIMEOUT_MS=15000
GETDONE_DB_SSL=true
GETDONE_BACKUP_MAX_AGE_HOURS=24
```

Do not place `DATABASE_URL` in browser configuration or any `NEXT_PUBLIC_*` variable.

## 1. Confirm PostgreSQL version

Run against the target:

```sql
SHOW server_version;
SHOW server_version_num;
```

`server_version_num` must be at least `160000`.

## 2. Apply migrations

From the exact release commit:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run db:migrate
```

The migrator acquires the GetDone advisory migration lock before applying ordered SQL migrations.

Current required migration sequence:

1. `2026-09-21.1`
2. `2026-09-21.2`
3. `2026-09-21.3`
4. `2026-09-21.4`
5. `2026-09-21.5`
6. `2026-09-22.1`
7. `2026-09-22.2`

Verify:

```sql
SELECT version, applied_at
FROM getdone_schema_migrations
ORDER BY version;
```

The latest row must be `2026-09-22.2`.

## 3. Backup and restore acceptance

A provider backup existing is not sufficient evidence. Restore a fresh backup into an isolated Supabase restore target or equivalent isolated PostgreSQL 16+ database.

Verify the restored target has:

- the same latest GetDone migration;
- the required authority/runtime tables;
- required unique/partial indexes;
- readable audit and runtime tables;
- no migration errors;
- no schema truncation or failed restore objects.

Produce a SHA-256 digest for the restore-verification evidence/artifact. Keep the raw backup location/credential material outside the repository.

Set:

```text
GETDONE_BACKUP_REF=<opaque provider backup/restore reference>
GETDONE_BACKUP_VERIFICATION_HASH=<64-character SHA-256>
GETDONE_BACKUP_COMPLETED_AT=<restore verification completion timestamp>
```

Then record the evidence:

```bash
npm run db:record-backup
```

Only the hash of the backup reference is persisted.

## 4. Run production verifier

```bash
npm run db:verify-production
```

The verifier must pass all of the following against the live target:

- PostgreSQL 16+;
- latest migration `2026-09-22.2`;
- SERIALIZABLE transaction isolation;
- rollback behavior;
- authorization-consumption concurrency/index enforcement;
- active Job lease concurrency/index enforcement;
- Job runtime transaction idempotency/index enforcement;
- audit-ledger schema integrity;
- fresh cryptographically recorded backup evidence.

## 5. Integration acceptance

The repository's `PostgreSQL Integration` workflow runs a real PostgreSQL 16 service and must pass:

- migration from an empty database;
- upgrade from `2026-09-22.1` to `2026-09-22.2`;
- production-verifier execution;
- concurrent authorization-consumption writes;
- concurrent active Job lease writes;
- concurrent Job runtime idempotency writes;
- concurrent SERIALIZABLE writers with exactly one serialization winner.

Run locally against an isolated PostgreSQL admin database with database-create privileges:

```bash
GETDONE_DB_SSL=false DATABASE_URL=postgresql://... npm run db:test-integration
```

Never point `db:test-integration` at staging or production; it creates and drops disposable databases.

## 6. Production runtime boot acceptance

After migration and backup verification:

1. start GetDone with `GETDONE_RUNTIME_ENV=production`;
2. confirm Postgres runtime health reports reachable/current schema;
3. verify no development seed repository can satisfy production reads;
4. verify authoritative writes persist and survive process restart;
5. verify Control API/database health reflects the actual connection state.

## Registry promotion rule

Do not change any of these solely because CI passes:

- `database.status`
- `adapters.postgresPersistence.status`
- `execution.durableJobStoreStatus`
- `controlApi.persistenceStatus`
- node persistence statuses
- environment connection booleans

Promote only the specific environment/component that has live evidence. Keep unrelated components fail-closed.

## Supabase boundary

Supabase is the managed PostgreSQL target, not an authority layer.

GetDone continues to own:

- transaction rules;
- authorization;
- idempotency;
- audit truth;
- Job state;
- verification truth;
- resource policy;
- release evidence.

Provider-side success never overrides GetDone authority state.
