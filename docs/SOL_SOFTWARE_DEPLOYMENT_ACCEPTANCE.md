# Software deployment, rollback, and production acceptance

This implements GetDone items 48–50 without weakening the existing production-promotion approval boundary.

## 48 — Real staging deployment target

The first live target is a Vercel custom environment named `staging`.

The protected GitHub `staging` environment must provide:

- secret `VERCEL_TOKEN`
- optional secret `VERCEL_STAGING_BYPASS_TOKEN` when Deployment Protection requires it
- variable `VERCEL_ORG_ID`
- variable `VERCEL_PROJECT_ID`
- variable `VERCEL_STAGING_ALIAS`
- optional variable `VERCEL_SCOPE`

The workflow uses a pinned Vercel CLI and `--target=staging`. A successful provider deployment is recorded as acceptance evidence with `authoritativeSuccess: false`. GetDone does not call that deployment successful until direct HTTP checks prove the health endpoint and owner-facing business surface.

## 49 — Controlled rollback acceptance

The live workflow:

1. deploys a known-good staging build,
2. points the controlled staging alias at it,
3. independently verifies `/api/health` and the owner surface,
4. deploys the same commit with the acceptance-only `GETDONE_DEPLOYMENT_ACCEPTANCE_MODE=force-unhealthy` runtime flag,
5. points the staging alias at the controlled bad deployment,
6. proves independent health verification fails,
7. repoints the alias to the exact known-good deployment,
8. independently verifies health and owner-surface recovery,
9. writes the complete hash-bound lineage to `test-results/software-deployment-acceptance.json`.

The fault-injection flag is ignored when `GETDONE_RUNTIME_ENV=production`, so this acceptance path cannot deliberately break production.

The workflow uploads the machine lineage and human summary as a 90-day GitHub Actions artifact. Failure after the bad alias is assigned also triggers best-effort alias recovery before the workflow exits failed.

## 50 — Production acceptance report

Run:

```bash
npm run production:acceptance-report
```

It generates:

- `release/out/production-acceptance-report.json`
- `release/out/PRODUCTION_ACCEPTANCE_REPORT.md`

The report answers:

- what the release registry and current evidence prove connected,
- what was tested live,
- the latest live-evidence timestamp,
- remaining production blockers,
- whether GetDone can enter the existing owner production-promotion approval boundary.

The report fails closed. Missing live deployment/rollback evidence is a blocker, and current `not-connected`, `unconnected`, `unconfigured`, development-only, or not-run release statuses remain blockers instead of being upgraded by code presence.

## Owner surface

`/operations/production-acceptance` renders the machine report, including the known-good deployment, controlled bad deployment, rollback target, recovery result, lineage hash, connected components, live tests, blockers, and promotion eligibility.

By default it reads `release/out/production-acceptance-report.json`. A deployment can point `GETDONE_PRODUCTION_ACCEPTANCE_REPORT_PATH` at a mounted or persisted copy. If no report is present, the surface shows **Blocked** rather than inventing live evidence.
