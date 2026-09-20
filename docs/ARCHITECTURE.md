# GetDone architecture baseline

## Current repository shape

The repository begins as a single Next.js TypeScript application so the visual shell, typed contracts, route handlers, and future server boundary can evolve without prematurely creating a distributed system.

### Implemented now

- Owner surface: Chat / Decisions / Resources
- Screenshot-aligned dark mobile shell
- Seeded DEVELOPMENT read models
- Development-only read endpoints
- Health endpoint
- Provider-neutral `GetDoneControlPlane` frontend contract
- CI gate for typecheck, lint, tests, and build
- PWA manifest metadata (full PWA/service-worker delivery remains a later phase)

### Explicitly not authoritative

The browser cannot approve production actions, set job/resource truth, enroll infrastructure, store production secrets, or execute model/provider work. Buttons that resemble those future flows are development previews only.

## Intended future boundaries

```text
Owner surfaces
  Chat | Decisions | Resources
          |
          v
GetDone Control API
  auth / scope / policy / approvals / audit
          |
    +-----+-----+
    |           |
    v           v
Intelligence   Execution
AI Gateway     Durable jobs / adapters
    |           |
    +-----+-----+
          v
Verification / outcomes
          |
          v
Resource control plane
```

OpenRouter/model integration is intentionally absent from feature code. When the AI Gateway phase begins, business features should call a GetDone-owned server contract rather than a model SDK directly.
