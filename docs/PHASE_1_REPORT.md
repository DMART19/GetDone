# Phase 1 — UFO v2 Visual Baseline and Mobile Shell

**STATUS: IMPLEMENTED — CI PASS; FINAL VISUAL REVIEW REQUIRED**

## Implemented

- Sign In visual shell.
- Home/Chat screen with screenshot quick actions and keyboard-safe composer placement.
- Permanent bottom navigation exactly Chat | Decisions | Resources.
- Decisions queue with High / Normal / FYI filters and detail route.
- Resources overview with health/capacity/spend/savings cards, filters, rows, and + Add Resource.
- Add Resource screen with Compute, Storage, Network, Cloud Provider, Data Center / Partner, Other, plain-language path, and screenshot-style Cancel action.
- Resource Detail ordered as resource identity -> Actions -> tabs -> three metrics -> metadata -> capabilities -> current workloads.
- Dedicated UFO v2 screenshot-fidelity stylesheet for the near-black/navy shell, electric-blue accents, restrained glow, compact typography, tighter cards, iPhone-safe composition, and centered desktop containment.
- Route loading, error, not-found, offline, reduced-motion, keyboard-focus, and skeleton states.
- Seed data is marked with a small DEV indicator and remains non-authoritative.
- Visual acceptance checklist exists in `docs/VISUAL_ACCEPTANCE.md`.

## Migrations

None. Phase 1 does not require a database.

## Tests / build

GitHub Actions has verified:

- dependency installation
- secret-pattern scan
- TypeScript typecheck
- ESLint
- Vitest
- Next.js production build

The Vitest path alias is explicitly configured in `vitest.config.ts`.

## Security checks

- No production secrets are required by the visual shell.
- DEVELOPMENT seed reads fail closed on a production owner surface.
- No production mutation or approval authority exists in the Phase 1 UI.
- No model/provider SDK is used by feature code.
- The frontend remains a control surface, not execution authority.

## Mobile checks

The implementation includes:

- iPhone-first max-width composition
- safe-area handling
- narrow-width adaptations
- no intentional horizontal page overflow
- composer placement above bottom navigation
- reduced-motion handling
- visible keyboard/focus-safe interaction design

Pixel-level screenshot fidelity still requires human visual review against the supplied reference; CI success alone is not represented as proof of pixel-perfect matching.

## Resource checks

Displayed resources remain development read models. No real enrollment, credentials, trust, telemetry, scheduling, placement, or READY authority is represented.

## AI gateway checks

No runtime model call is used by the Phase 1 owner surface. The Control API boundary remains provider-neutral.

## Environment variables

Only non-secret environment placeholders exist in `.env.example`.

## Infrastructure

No production host/database/queue/worker is required to verify the visual shell.

## Owner actions

Review the running UI against the supplied UFO v2 screenshot once a preview deployment/local runtime is available.

## Deferred from Phase 1

Real authentication/session authority, persistent tenant scope/RLS, production decisions/resources, AI Gateway/OpenRouter, durable jobs, resource enrollment, credentials, telemetry, placement/scheduler, failover, production deployment authority, push/passkeys, voice, and Watch remain later-phase concerns.

## Next phase ready

**YES for repository work.** Phase 2/3 canonical PASS still depends on real authentication and database infrastructure, as documented separately.
