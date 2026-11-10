# Production acceptance gates

CI provides automated checks; it does not by itself establish production acceptance. Keep this checklist with each release and attach dated staging evidence.

## Governed execution
- [ ] For every enabled provider/action: plan, policy decision, required approval, execute, verify result, and audit record pass end to end.
- [ ] Deny unapproved actions through API calls, callbacks, retries, and worker paths.
- [ ] Demonstrate kill switches and credential revocation stop subsequent execution.
- [ ] Run live staging acceptance for AI, Gmail, Slack, configured HTTP, and webhooks before enabling each integration.

## Durable workers and data
- [ ] Exercise concurrent workers, duplicate delivery, idempotency, lease expiry, process crash, restart recovery, and queue backlog against production-like PostgreSQL.
- [ ] Verify owner provisioning, session expiry/revocation, and tenant isolation using separate identities.
- [ ] Apply migrations from clean and upgrade databases; validate rollback or forward-fix procedures.

## Operations and release
- [ ] Complete browser and mobile staging acceptance.
- [ ] Record backup restore evidence, health alerts, incident runbook, rollback procedure, and operational owner.
- [ ] Record commit SHA, CI run, enabled capabilities, staging evidence, and release decision.
