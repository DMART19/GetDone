# Tenant-scoped conversation continuity and multi-business routing

## Implemented on refinement branch

- Chat POST and status GET continue through the existing Control API and its Postgres-backed authoritative adapter.
- GET `/api/control/chat` now returns up to 100 persisted owner intent records for the **authenticated user + portfolio + company** in chronological order. It uses `owner_intents` (no new vendor or schema migration) and `cache-control: no-store`.
- The frontend loads saved turns when the owner selects an authorized business. Switching clears prior UI context, cancels pending polls and loads that business's history.
- The catalog now includes the membership role for presentation. Only portfolios whose active role is **owner** are offered for mutating chat. The server still independently verifies membership/role via `PostgresControlApiScopeResolver` and the service adapter.
- Owner requests and status polls carry `X-GetDone-Portfolio-Id` only after explicit selection. The header is a **requested scope**, not proof of authority.
- The persisted preceding intent, topic and entity references are used for simple follow-ups *inside the same user, portfolio and company*. A topic switch does not carry unrelated integration/objective references.
- “Fix that” and other action continuations **do not inherit approval or execution rights** from chat history; without an authoritative proposal they request clarification.

## Intentional constraints

- This release provides **one latest-context thread per owner and portfolio**, not multiple named conversation threads.
- The history endpoint restores user messages and assistant answers already persisted on intent records. Asynchronous worker narratives still need a fully durable assistant-turn transcript; no claim that every live progress message persists.
- Continuation is deterministic and conservative, not yet a full semantic model + ambiguity-resolution engine. A user referring to another business must explicitly select that authorized portfolio. Cross-portfolio context transfer is disabled.
- The global read-only owner radar and worker execution logic are unchanged. No new execution authority is introduced.
- Existing selected-portfolio views, approvals and passkey step-up remain guarded by their existing APIs.
- A full staging pass must still demonstrate genuine authenticated two-owner/two-tenant switching, database restart continuity, authorization denials, and independent worker outcome verification. Unit tests and browser smoke tests cannot replace that acceptance.

## Required staging test

1. Provision two **staging-only** portfolios and distinct authenticated users, with owner access to both for one user and restricted membership for the second.
2. Sign in with real WebAuthn. Create a turn for portfolio A, switch to B and submit a different turn.
3. Refresh and sign back in; A must show only A's history and B only B's.
4. Try `X-GetDone-Portfolio-Id` for a portfolio without membership: require 403 and no returned text.
5. Change role or revoke membership, then repeat GET, POST and status GET; the previous valid session must not be able to access revoked scope.
6. Ask “Why?”, “What about marketing?” and “Fix that” within A. Verify tenant-scoped references and no unapproved side effects.
7. Restart web and worker processes. Check persisted intent lineage and confirm decisions/execution still require independent authorization.
8. Run tenant isolation, audit, idempotency, failure recovery and the full approval → worker → independent verification acceptance before production.
