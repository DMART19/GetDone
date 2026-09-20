# Phase 3 — Portfolios, Companies, Memberships, and Resource Scope

**STATUS: OWNER ACTION REQUIRED**

## Implemented

- Deterministic trusted-scope guard for portfolio/company/resource IDs.
- Revoked-membership denial.
- Tests for cross-company and cross-resource ID tampering.

## Migrations

None. A production persistence target has not been selected.

## Security checks

The scope helper treats browser/request identifiers as requested objects only; authority must come from a trusted membership grant resolved server-side.

## Owner actions

Choose/provision the authoritative database. If Postgres/Supabase is selected, add migrations and RLS policies and run adversarial cross-tenant tests against the real database.

## Deferred

- Users/portfolios/companies/memberships persistence.
- RLS.
- Membership revocation persistence.
- Server-side database-backed scope resolution.

## Next phase ready

**NO for canonical PASS.** Pure deterministic domain work may continue without claiming persistence exists.
