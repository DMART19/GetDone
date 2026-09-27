# Lovable Handoff — UFO v2 Frontend

This branch contains the GetDone owner frontend aligned to the supplied UFO v2 visual source.

## Branch

`feature/ufo-v2-screenshot-frontend`

## Pull into Lovable

Use the existing GitHub project/repository connection and import this branch rather than rebuilding the app from a blank Lovable project.

Lovable should treat the existing code as authoritative for behavior and the supplied UFO v2 screenshot as authoritative for visual fidelity.

## Preserve these rules

- Permanent bottom navigation is exactly **Chat · Decisions · Resources**.
- Keep the iPhone-first dark UFO v2 presentation.
- Keep the owner flow simple even though the backend is complex.
- Do not connect components directly to OpenRouter, Gmail, Slack, GitHub, AWS, Cloudflare, or other providers.
- Frontend actions go through the GetDone Control API.
- Development mode may use seed/read-model data.
- External provider credentials and live API setup remain a final integration phase.
- Do not replace the existing approval, policy, idempotency, passkey step-up, job, verification, resource, or authority contracts.
- AI output remains advisory/proposal data. GetDone remains the authority boundary.

## Current owner routes

- `/` — Chat / command center
- `/decisions` — governed owner decision queue
- `/decisions/[id]` — decision detail and approval flow
- `/resources` — resource overview
- `/resources/add` — governed resource enrollment entry
- `/resources/[id]` — resource detail
- `/sign-in` — sign-in
- `/offline` — offline state

## Frontend behavior already wired

- Chat submits through `/api/control/chat` outside development preview mode.
- Decision approval uses the existing Control API and passkey step-up flow.
- Resources use the runtime owner repository so development seeds can later switch to authoritative data without rebuilding the screens.
- Bottom navigation, deep links, loading/error/not-found/offline states, PWA behavior, and mobile-safe layout are already in the repo.
- Hamburger menu is functional on this branch.
- Resource dashboard groups match the UFO v2 concept: Cloud Providers, Data & Storage, Integrations, Team & Agents.

## Visual source of truth

Also read `docs/VISUAL_ACCEPTANCE.md` before editing.

Do not turn the owner experience into a generic admin dashboard. The desired product feel is:

**ASK → REVIEW → APPROVE → DONE**

with the complexity hidden behind GetDone.
