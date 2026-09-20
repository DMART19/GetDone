# Phase 1 — UFO v2 Visual Baseline and Mobile Shell

**STATUS: IMPLEMENTED — local/CI verification required after dependency install**

## Implemented

- Sign In visual shell.
- Home/Chat screen with screenshot quick actions and keyboard-safe composer placement.
- Permanent bottom navigation exactly Chat | Decisions | Resources.
- Decisions queue with High / Normal / FYI filters and detail route.
- Resources overview with health/capacity/spend/savings cards, filters, rows, and + Add Resource.
- Add Resource screen with Compute, Storage, Network, Cloud Provider, Data Center / Partner, Other, and plain-language path.
- Resource Detail with Overview / Usage / Cost / Health tabs, key metrics, metadata, capabilities affordance, and current workloads.
- Responsive iPhone-first shell with desktop containment rather than an admin-dashboard transformation.
- Development, empty, offline, and local-preview states.
- Seed data is visibly labeled DEVELOPMENT and non-authoritative.

## Migrations

None. No database has been introduced.

## Tests

- Seed-data unit tests added.
- CI workflow runs dependency install, typecheck, lint, tests, and build. Local dependency installation could not be completed in the execution sandbox, so GitHub Actions is the verification authority for this commit.

## Security checks

- No secrets in frontend or repository.
- Development read endpoints disable themselves under production `NODE_ENV`.
- No production mutations or approval authority exist.
- No model/provider SDK is included.

## Mobile checks

CSS includes safe-area handling, narrow-width adaptations, no intentional horizontal page overflow, and a composer positioned above bottom navigation.

## Resource checks

All resources are seed read models. No enrollment, credentials, trust, telemetry, scheduling, placement, or real READY state exists.

## AI gateway checks

No model calls are implemented. The future control-plane boundary is provider-neutral.

## Environment variables

Only non-secret environment placeholders exist in `.env.example`.

## Infrastructure

No production host/database/queue/worker has been selected in this phase.

## Owner actions

Choose/deploy real infrastructure only when the corresponding phase requires it. Do not add production keys merely to make the visual baseline work.

## Deferred

Authentication/session authority, tenancy/RLS, capability registry, state machines, audit ledger, signal bus, AI Gateway/OpenRouter, durable jobs, resource enrollment, credentials, telemetry, policy, placement, scheduler, storage fabric, failover, production deployment authority, push/passkeys, voice, and Watch.

## Next phase ready

YES after CI/local verification passes.
