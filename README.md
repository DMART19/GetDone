# GetDone — UFO v2

GetDone is an iPhone-first owner control surface for a governed autonomous execution system. The permanent owner navigation is intentionally small: **Chat · Decisions · Resources**.

This repository currently contains the **Phase 1 visual baseline** plus a small, non-authoritative development API shell. It intentionally does **not** contain production authentication, real approvals, resource enrollment, scheduler authority, credential brokerage, AI gateway execution, or production side effects.

## Run locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Verify

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Current routes

- `/` — Home / Chat shell
- `/decisions` — unified decision queue
- `/decisions/[id]` — development decision detail
- `/resources` — resource overview
- `/resources/add` — add-resource visual flow
- `/resources/[id]` — resource detail
- `/sign-in` — sign-in visual shell (auth intentionally deferred)
- `/offline` — explicit offline state
- `/api/health` — basic service health
- `/api/dev/resources` and `/api/dev/decisions` — development-only seed reads; disabled when `NODE_ENV=production`

## Authority rule

**AI thinks. GetDone authorizes. Workers execute. Resources supply capacity. Verification establishes truth.**

The frontend is a control surface, never the source of execution truth. Development interactions in this phase are clearly labeled and produce no production side effects.

See `docs/PHASE_0_REPORT.md`, `docs/PHASE_1_REPORT.md`, `docs/ARCHITECTURE.md`, and `docs/ASTRA_HANDOFF.md` before continuing implementation.
