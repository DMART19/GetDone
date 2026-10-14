# David Edition v37 — Native GetDone Frontend Integration

## Scope delivered
This branch replaces the existing GetDone navigation shell and its **Decisions** and **Resources** pages with an owner command layout inspired by the standalone v37 Resolve First design.

Unlike the demo, the Decisions page loads its data from `getOwnerReadRepository().listDecisions()`. Approval, modification and rejection are delegated to the existing `DecisionActions` component, which calls `PATCH /api/control/decisions/:id`, includes idempotency keys, and uses the existing passkey step-up flow when required. The Resources page still uses `getResourceSummary()` and `listResources()`. The Universe home still renders authenticated `BusinessSystem` and established objective/chat components.

## Critical compatibility limits
This is a **native frontend migration**, NOT a bit-for-bit port of the standalone Vite Three.js canvas. The standalone Vite app includes its own mock decision/resource models and unsafe local simulation actions. Those have deliberately **not** been mounted inside the authenticated server app. The existing real business universe remains on Home. Cinematic Three.js assets, sample-v37 mock planets and owner-input choices are **not** injected into production data.

An arbitrary staging service selection must not be sent through the decision PATCH endpoint: its schema supports `approve`, `modify`, or `reject`, not a target identifier. Owner-input capture therefore needs a dedicated authorized backend contract before replacing that flow. No fake write is presented.

The current `DecisionActions` component intentionally previews mutations in the development runtime; test staging with `NEXT_PUBLIC_APP_ENV=staging` and the real auth configuration.

## Required checks before merge/deployment
- `npm ci && npm run typecheck && npm run lint && npm run build`
- Signed-out redirect, owner session, isolation with another tenant, expired session
- Real decisions list: pending/processed, search, inspector, approve/reject/modify, passkey step-up, idempotency replay, router.refresh()
- Resources list and links, empty/error states, mobile and keyboard testing
- Home planet/business context, existing authenticated chat and objective workflows
- Staging smoke test across restart and a known failed authorization

Do not merge or deploy without acceptance. This branch does not grant any new backend authority.

## Follow-up implementation
1. Port full Three.js canvas and adapt it to authenticated `/api/businesses` contracts with lazy loading and error fallback.
2. Define/implement secure owner-input field submission schema, associated policy, and verification.
3. End-to-end Playwright acceptance of command bridge and approval flows.
