# Owner Action Checkpoints

Only actions that require a real external account, infrastructure selection, physical device, or secret should stop automated repository work.

## Checkpoint A — Authentication

**Needed for:** canonical Phase 2 PASS.

Choose/provision the production authentication/session implementation.

The implementation must support:
- server-verifiable sessions
- refresh/expiration
- revocation/logout
- secure persistence for PWA use
- a separate fresh step-up path for strong approvals
- passkey/WebAuthn support where practical

Never commit provider secrets to the repository.

## Checkpoint B — Authoritative database

**Needed for:** canonical Phase 3 PASS and later persistent authority.

Choose/provision the authoritative database.

Required validation:
- User -> Portfolio -> Company hierarchy
- memberships/roles
- server-resolved scope
- row-level or equivalent authorization
- cross-tenant denial
- membership revocation
- environment isolation

## Checkpoint C — Deployment/runtime

**Needed before:** durable background jobs and production callbacks.

Choose/provision:
- production web/control API runtime
- persistent worker runtime
- queue/scheduler infrastructure
- secret manager
- observability/logs
- backup/restore path

Important background work must not depend on an open browser, phone, laptop, or temporary AI session.

## Checkpoint D — AI gateway credential

**Needed for:** Phase 13 production gateway canary.

Provide the OpenRouter key only through the future secure server-side write-only setup path. Do not commit or paste the raw key into source files.

## Checkpoint E — Resource credentials/hardware

**Needed for:** Resource Fabric acceptance.

Later checkpoints include:
- physical Raspberry Pi enrollment
- provider/cloud credentials
- Home NAS enrollment
- second resource provider
- partner/data-center pool credentials

These should be minimum-scope, revocable, environment-bound credentials.
