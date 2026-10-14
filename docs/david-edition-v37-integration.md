# David Edition v37 — live GetDone integration

This branch is a **feature-flagged staging candidate**, not a validated production frontend replacement.

## What is actually wired
- `GETDONE_DAVID_EDITION=true` opts into the David Edition shell and owner bridge inherited from staging PR #125.
- `/decisions` renders `DavidEditionDecisionCommand` using **the existing server-side, authenticated** `getOwnerReadRepository().listDecisions()` data; no fictional queue or sample statuses.
- Approve / Modify / Reject render the **existing DecisionActions**, which sends `PATCH /api/control/decisions/:id` with idempotency key and supports passkey step-up when required. This design does not add an alternate mutation API.
- Decision inspector displays presentation evidence only where provided; unsupported evidence is not fabricated.
- `/resources` continues to use the existing scoped repository and `ResourceOverview`.
- `/` continues to use the existing `BusinessSystem` with authenticated `/api/businesses`.

## Remaining work before claiming the **exact full v37 standalone frontend** replaced the site
- Copy, compile and stage the v37 Vite 3D scene and styling into the Next.js public assets or implement as native R3F components. This branch does not include the 63KB `src/main.tsx`, 98KB CSS, and related sandbox UI assets.
- Replace any simulated decision/resource data in the standalone scene with safe authenticated same-origin adapters.
- Implement scene-to-chat routing and synchronized business selection via real contract and authorization checks.
- Validate Content Security Policy and fallback behavior.
- Run TypeScript, Next.js build, Playwright desktop/mobile, auth/tenant isolation, passkey approval and staging acceptance.

## Release checklist
1. Set `GETDONE_DAVID_EDITION=true` in **staging only**.
2. `npm ci && npm run typecheck && npm run build && npm run test`.
3. Test signed-out redirect; owner role; another tenant cannot view any decision or approve it.
4. Check real decisions; search/filter; expand evidence; approve/modify/reject with permitted test decisions only.
5. Verify passkey step-up, idempotency, denial paths, refresh, and audit.
6. Test real business catalog and resources and conversation.
7. Disable flag and verify original UI recovers.
8. Complete scene asset integration before visual parity acceptance.
9. Only after these pass, request separate explicit authorization for production frontend replacement.

No production deploy or merge is part of this change.
