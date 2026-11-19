# GetDone authentication / RLS launch boundary (issue #133)

**Status: code candidate only. Migration not applied to live staging or production. Security review and isolated Postgres integration tests required.**

## Why this exists

GetDone's pre-authentication endpoints previously used `PostgresDatabase` with `GETDONE_DB_RUNTIME_ROLE=getdone_tenant_runtime`. The tenant role correctly has no unscoped RLS visibility into authentication and membership tables, so owner sign-in and company lookup could fail even when TLS, schema, and web startup appeared healthy. The database-side read-only probe confirmed this in staging (one owner and three memberships visible to the admin, zero to tenant role).

## Narrow access design

- Migration `2026-10-17.1_auth_runtime_boundary.sql` introduces NOLOGIN, NOBYPASSRLS `getdone_auth_runtime`, separate from the tenant role. No new database login or secret is required to build/test the code.
- The authentication connection sets the auth role explicitly and is used only for server-side passkey sign-in, session management, invitation consumption, active-membership resolution, and hashed request rate limiting.
- Role permissions are limited to SELECT on identity/membership/challenge tables, specific INSERT and UPDATE columns for passkey/session lifecycle, and SELECT/INSERT/UPDATE on `rate_limit_buckets`. It cannot DELETE enrollment records, issue invitations, change auth-user status, or query business execution/authorization tables.
- Server-only table-specific RLS policies target **only `getdone_auth_runtime`**, never `getdone_tenant_runtime`, `anon`, or `authenticated`. The auth role necessarily sees pre-tenant identity metadata; application queries bind token hashes and authenticated user IDs and validate active membership joins.
- `getdone_tenant_runtime` remains scoped to business transactions. No RLS bypass, TLS downgrade, superuser grant, production worker reuse, or unauthenticated public endpoint is introduced.
- A dedicated PostgreSQL client pool is reused per web process, rather than allocating a pool for every auth request. All connections use the existing certificate-verifying TLS configuration.
- Control API health now requires an effective role check with visible active owner and company membership; relation presence alone is insufficient.

## Review gates and rollback preparation

1. Review DDL against a disposable database first: verify role membership, per-table grants and RLS policies. Check the role has no privileges on `control_plane_entities`, `authorization_grants`, `job_*` and other execution tables.
2. Run the complete GitHub CI suite and the optional isolated role integration test. Set `GETDONE_AUTH_BOUNDARY_INTEGRATION=true` and `GETDONE_AUTH_BOUNDARY_TEST_DATABASE_URL` to a **locally hosted, pre-migrated disposable database** with a name starting `getdone_auth_test_`. That test rolls back its fixtures and rejects non-local databases.
3. Confirm `OwnerEnrollmentService` invitation locking remains safe across concurrent registration/reissuance. It locks the enrollment row, rechecks token/state under that lock, and does not need UPDATE privileges on `auth_users`.
4. Apply the reviewed migration **only to staging** after an actual verified backup and restore; then run `node scripts/verify-staging-runtime-config.mjs --connect` from the private staging web shell. It must pass both auth-role visibility and tenant-role isolation.
5. Confirm real owner-driven WebAuthn registration, login/logout, step-up, revoked credentials, multiple businesses, and protected action denial; do not fabricate login or approval evidence.
6. Keep this PR draft until all checks pass. For rollback, revert web deployment to its previous pinned candidate before modifying privileges. Never drop the auth role while a service depends on it; reverse privileges only after confirming no active auth sessions are using the role.

## Known limitations

- Role separation uses `SET ROLE` under the existing authenticated database connection. A future fully isolated database login would provide a stronger credential-level boundary; this change establishes enforceable least-privilege **query roles**, not independent secrets.
- CI without a local disposable PostgreSQL server exercises mocks, static migration checks and SQL unit tests, not a real staging passkey or database migration.
- The live owner passkey and fresh verified backup remain uncompleted; no migration or Render changes were made by this PR.
