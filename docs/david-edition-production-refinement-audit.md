# David Edition — production refinement audit (2026-10-14)

## Verified source mapping
| Surface | Current authoritative source | Mutation / notes |
| --- | --- | --- |
| Home business universe | `app/page.tsx` -> `BusinessSystem` -> `GET /api/businesses` -> `getBusinessCatalog` / `getBusinessContext` | Currently SVG orbital visualization, **not** the standalone v37 Three.js scene |
| Decisions | `app/decisions/page.tsx` -> `getOwnerReadRepository().listDecisions()` -> `DavidDecisionDesk` | `DecisionActions` -> `PATCH /api/control/decisions/[id]` -> `handleMutateDecision`; step-up via existing passkey endpoints |
| Resources | `app/resources/page.tsx` -> `getOwnerReadRepository().getResourceSummary()/listResources()` -> `DavidResourceDesk` -> `ResourceOverview` | Read-only surface |
| Owner shell | `AppShell` -> `DavidEditionShell` when `GETDONE_DAVID_EDITION=true` | Original navigation restored when flag is off |
| Objectives/chat | Existing `HomeDashboard` and business-context surfaces | No new duplicate chat or objective store introduced |

## Refined in this PR
1. Restored reversible server-side feature flag on the shell, Decisions, Resources and home branding. Default OFF.
2. `DecisionActions` reconciles status after server refresh and disables resolved decisions; server still enforces authorization, idempotency, policy and step-up.
3. Added GitHub quality gate: typecheck, lint, Next build, architecture verification, secret verification.

## Evidence limitations / production blockers
- The native branch does **not** include the complete Vite v37 Three.js planet scene, resource satellite graphics, camera motion, or cross-surface scene bridge. Do not claim pixel parity or completed frontend replacement.
- `DecisionActions` deliberately performs local preview mutations when `NEXT_PUBLIC_APP_ENV=development`; staging must set an authoritative runtime mode.
- `router.refresh()` reconciles the decision page; **not yet proven** that all other surfaces, worker state, objective outcomes and health update after a real approval.
- Existing decision `PATCH` accepts only approve/modify/reject. Owner-input form submissions must not be simulated as approval actions.
- The business visualization has no verified operational health aggregator. Do not turn an integration's recorded status into a green planet without evidence.
- No production or staging deployment, live owner login, passkey ceremony, real worker execution, or cross-tenant acceptance was performed in this PR.
- CI results are required before merge. No claims of zero warnings or production readiness until they pass.

## Staging acceptance before promotion
1. Build with flag OFF and ON; confirm old UI rollback and David Edition shell.
2. Verify signed-out and expired sessions cannot read decisions/resources/business context; verify cross-tenant denial.
3. Confirm real business catalog and resource records and honest unknown states.
4. Use a disposable staging decision and real owner passkey; approve via existing PATCH, verify persisted decision, audit record, job queue, worker outcome, independent verification and objective state.
5. Refresh all affected views and another browser tab; verify consistent state. Check failure, retry and idempotency.
6. Test desktop/mobile keyboard navigation and full visual assets only after the actual scene is ported.
7. Require explicit owner authorization for production deployment; do not merge or change production before acceptance.
