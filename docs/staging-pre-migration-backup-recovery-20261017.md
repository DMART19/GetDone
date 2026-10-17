# GetDone staging pre-migration recovery ceremony

**Status: engineering candidate only. Real staging backup/restore has NOT run. Do not migrate live staging until the restore evidence is verified and the owner authorizes the migration.**

## Why this runs from the existing staging branch

Live Supabase staging project `ddxjiszbsmmbqxuoecmg` currently reports GetDone schema `2026-10-10.1`. The pending launch candidate requires `2026-10-17.1` (authentication role) and `2026-10-17.2` (worker role/tenant isolation). Taking a **pre-migration** backup from the pending candidate fails the intentional schema-version pin. Run this ceremony from `launch/staging-pre-migration-backup-restore-20261017`, based on the old staging branch with registry `2026-10-10.1`.

Do not run the migration from this branch. Apply the new DDL later from the reviewed, tested candidate, only after this pre-migration recovery gate is marked PASS.

## Requirements before touching the source

1. Execute the commands in a private, access-controlled environment with `pg_dump` and `pg_restore` compatible with the source PostgreSQL server. The existing free Render staging web shell may not be available. Never put source credentials in chat, a GitHub issue, workflow run, build logs, or git files.
2. Use the exact staging-only `DATABASE_URL`. The script rejects other Supabase project hosts/usernames and production mode.
3. Require `GETDONE_RUNTIME_ENV=staging`, `GETDONE_DB_SSL=true`, `PGSSLMODE=verify-full`, and a local trusted `PGSSLROOTCERT` file for the staging source. Verify actual CA trust against staging; do not disable validation.
4. Provide a **separate isolated PostgreSQL server** on the executing machine at `localhost` or `127.0.0.1` for `GETDONE_RESTORE_ADMIN_DATABASE_URL`. It must have database-creation rights and verified TLS if needed by the restore script; configure `GETDONE_RESTORE_PGSSLROOTCERT` if this target has a separate CA. The command creates a random `getdone_restore_verify_...` database; it never drops an existing database on startup, and deletes only the one it successfully created.
5. The private backup destination must be on a secure volume, with sufficient free space and no preexisting dump or manifest. The dump contains potentially sensitive business data; never publish it.

## Execute

Supply the following variables **privately** from your staging credentials and a fresh local restore server; do not print them:

- `DATABASE_URL`: exact staging Supabase project `ddxjiszbsmmbqxuoecmg`
- `GETDONE_RESTORE_ADMIN_DATABASE_URL`: dedicated local restore cluster, **never the source**
- `GETDONE_RUNTIME_ENV=staging`, `GETDONE_DB_SSL=true`, `PGSSLMODE=verify-full`
- `PGSSLROOTCERT`: actual source CA trust file; optionally `GETDONE_RESTORE_PGSSLROOTCERT` for local restore
- `GETDONE_BACKUP_FILE`: unique absolute path on your **private** volume
- `GETDONE_BACKUP_MANIFEST`: unique private manifest path

Then run:

```bash
node scripts/backup-and-verify-staging.mjs
```

The script verifies the live **source schema before backup**, exports one consistent PostgreSQL snapshot, writes a mode-0600 dump and hashed manifest, restores to a separately created database, validates restored hashes/domain invariants/audit-ledger integrity, and launches the restored application to check database and auth health. On first run it **does not** publish a verified backup evidence row to staging.

Retain the dump + manifest in approved, access-controlled durable storage. Independently compute and compare the stored dump's SHA-256. Once your retained copy matches, privately configure `GETDONE_BACKUP_EXTERNAL_SHA256` to the verified SHA, `GETDONE_BACKUP_DURABLE_COPY_CONFIRMED=true`, and `GETDONE_BACKUP_REF` to a nonsecret stable reference. Rerun against the existing files:

```bash
node scripts/backup-and-verify-staging.mjs --verify-existing
```

A successful second restore plus valid retained copy evidence may write **one genuinely verified source-side** `database_backup_evidence` row with the restored schema version and content hashes. Do not use a manual SQL insert, fabricate hashes, or override backup maximum age.

The source and the backup artifacts must remain private. The printed JSON contains only redacted status, version, and content hashes; retain this output in private release evidence.

## Required pass/fail evidence

- **PASS** source schema is `2026-10-10.1` and source database is the approved staging project with certificate-verified TLS.
- **PASS** complete `pg_dump` file and manifest hashes agree and the dump remains available in durable private storage.
- **PASS** isolated restore has matching composite and component hashes, domain invariants, and independent audit verification.
- **PASS** restored application starts with `authConnected=true` and `persistenceConnected=true`.
- **PASS** a *post-restore*, content-linked fresh verified evidence record is present on the staging source, no more than 24 hours old.
- **FAIL CLOSED** if any step fails, if TLS cannot be proven, if source or target are incorrectly identified, if a restore database already exists, or if a durable copy cannot be validated. No source migration may occur after FAIL.

After a real PASS: independently review PR #134 and PR #136 security and migrations; approve applying **only** `2026-10-17.1` and `2026-10-17.2` to staging using the standard migration system with an approved staging-only administrator connection, pinned candidate SHA, and dedicated rollback/response plan. This migration approval is a separate owner decision and is **not implicit in a successful backup**. Then take another genuine backup of the **post-migration** schema and independently restore it before worker activation.

No production changes and no paid database or worker services are authorized by this document.
