# Astra handoff

This repository was intentionally front-loaded with work that is low-risk and deterministic: the Phase 0 empty-repo reconnaissance, Phase 1 owner-facing shell, typed development read models, a provider-neutral frontend control-plane contract, and CI scaffolding.

## Do not mistake the mock UI for authority

Everything that can look consequential in the current UI is a development preview. No resource is actually enrolled, no approval is authoritative, no production action is dispatched, and no AI/provider is connected.

## Best next work for a stronger coding agent

Continue in the master build-plan order rather than jumping straight to autonomy:

1. Phase 2 — secure authentication/sessions and step-up architecture.
2. Phase 3 — User → Portfolio → Company membership hierarchy plus RLS/authorization tests.
3. Phase 4 — business integration onboarding with server-side credentials.
4. Phase 5–8 — capability registry, objectives/guardrails, deterministic state machines, audit/idempotency.
5. Later intelligence/execution phases — only after server authority is real.
6. Phase 13 AI Gateway — OpenRouter behind a GetDone-owned interface; models never become authority.
7. Resource Fabric phases — registry/enrollment/agent/credentials/policy/placement in the specified order.

## Important implementation constraints

- Keep bottom navigation exactly Chat | Decisions | Resources.
- Keep the screenshot-simple owner experience even as backend complexity grows.
- Never let frontend/model/provider callbacks set approval, job, resource-trust, placement, or verification truth.
- Do not put raw production secrets in browser storage, client bundles, logs, prompts, resource metadata, or docs.
- Prefer vertical slices and deterministic tests over broad placeholder abstractions.
- Run the build-plan completion gate at the end of every numbered phase and write/update a phase report.

## Current extension seam

`lib/control-plane/contracts.ts` is only a frontend-facing seam. Replace development transport with authenticated server-authoritative APIs when Phase 2+ begins; do not turn the browser contract itself into the authority layer.
