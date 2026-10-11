# Business homepage

The homepage displays companies joined to the signed-in owner's active organization,
company, and portfolio memberships. A company without all three memberships is
excluded. GetDone is the center; each company is a selectable planet. No company
fixtures are shipped to the production UI.

`GET /api/businesses` returns the authorized catalog and most recent recorded activity.
`GET /api/businesses?portfolioId=...` rechecks memberships and reads the selected
company under the existing PostgreSQL tenant scope. Both use the existing session
cookie/bearer authentication and no-store API envelope. Detail projections return
only record IDs, display titles, states and timestamps, with at most 20 records per
section. Integration metadata and credential bindings are not exposed. Environment
is enforced for environment-bearing records; existing decision/job/outcome models
are scoped by tenant and database and may omit it.

The context provides objectives, integrations, decisions, jobs and recent recorded
outcomes. Signals explicitly report that no persistent signal feed is connected to
this view. Activity timestamps mean records changed, not business health or proof
that a provider is currently reachable. Opening a planet does not grant permissions
or execute work.

The existing objective/chat workspace continues for accounts with one active
business. Multiple-business owners can inspect each context; a global business
switcher for mutation workflows remains future work. Selection does not silently
change the tenant of existing API mutations. Navigation and detail routes retain
their existing scope requirements.

## First business

The empty state explains administrator provisioning and links to `/setup/owner`
for an existing owner invitation. Use the owner and company provisioning procedure
in `POSTGRES_SUPABASE_PRODUCTION_RUNBOOK.md`, then `NARROW_LAUNCH_RUNBOOK.md`
for owner enrollment and governed integration commissioning. There is no self-service
company creation endpoint; the UI does not pretend to create one.

## Verification

- `npm ci --include=dev --ignore-scripts --no-audit --no-fund`
- `npm run lint` and `npm run typecheck`
- `npm run test -- lib/businesses/repository.test.ts`
- `npm run test:e2e:staging -- e2e/staging/business-system.spec.ts` with the documented
  staging PostgreSQL/TLS configuration; this resets the **disposable staging test DB**.
- `npm run test:e2e` for existing desktop/mobile navigation and objective behavior.
- `npm run build`, then `npm run dev` for local visual acceptance (sequentially).

Staging business tests seed synthetic OpsManagerPro and StatusWatchPro company rows
and read them through the real database/API. Request interception is limited to
loading/failure-state tests. These names are never inserted by application startup.
