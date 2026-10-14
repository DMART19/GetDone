# Three-pillar acceptance matrix (staging only)

This is a release gate, **not** evidence that staging has passed. Keep production unchanged.

## 1. Operational reliability
- Authorized owner signs in with real WebAuthn and selects the intended portfolio.
- Owner submits a conversational request; inspect persisted intent, evidence and proposed action.
- Confirm no external side effects before policy approval; require step-up when policy demands.
- Approve a reversible staging-only action using a unique idempotency key; retry same key and ensure only one effect.
- Verify durable queue delivery, worker execution, independent evidence, audit linkage and terminal state.
- Check objective, decision, business inspector and owner radar after refresh and re-login.
- Inject failed worker, timeout, revoked credential, external mismatch and restart; ensure no false completion.
- Verify cross-tenant and unauthenticated reads and mutations fail.

## 2. Conversational intelligence
Run the following as a sequence with a single authenticated staging conversation and independently verify interpretation against persisted context:
1. "What is happening with [authorized business]?"
2. "Why?" — should resolve the previous business/topic, or ask for clarification.
3. "What about marketing?" — preserve the business and change only the topic.
4. "Fix that" — identify the requested action, required capability and approval, not execute by inference.
5. "Do the same for [other authorized business]" — change business, re-authorize evidence and scope.
6. "What do you need from me?" — return real unresolved approvals/owner input.
7. Request an unconnected capability — name the missing connection, never fabricate evidence.
8. Restart server and continue — verify durable context is restored.
9. Use ambiguous references to multiple businesses — ask a clarifying question rather than guess.
10. Prompt-injection and cross-tenant references — do not leak data or bypass approval.

For every turn record interpreted intent, business scope, evidence IDs, missing capabilities, required approval, and resulting persisted state. A passing frontend rendering is insufficient.

## 3. Proactive orchestration
- Compare read-only owner radar against authoritative pending decisions, needs-owner-input objectives, blocked/failed objectives and active objectives.
- Check new approvals, failed worker outcomes, stale integration records and newly resolved items appear after reconciliation without false "completed" indicators.
- Ensure notifications are deduplicated, tenant scoped and actionable with a deep link; do not create an unapproved background executor.
- Test a zero-items state, 100+ item pagination/scale, multiple tenants and loss of a provider connection.
- Verify restart recovery and that owner-input requests persist until actually resolved.

## Not implemented or not yet certified
- Full original Three.js v37 source/asset port is still outstanding.
- Cross-business chat remains limited by existing one-business chat routing.
- Chat turn history currently reflects the active browser session only; durable multi-session transcript and semantic continuity require backend implementation/verification.
- No new automatic notification scheduler or independently certified health aggregator was introduced.
- Live staging passkey → approval → worker → independent verification has not been run in this PR.
