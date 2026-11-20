# Conversational business interface

Base: `main` at `eca08722ecacdf8cea1a90a92b9bca85e50f0f00` (merged PR #121).
Implementation branch: `codex/conversation-business-interface`.

## What changed

- Chat attempts structured semantic interpretation through the existing AI Gateway. A strict Zod contract covers seven intents, confidence, business reference, topic, action intent and clarification. Missing configuration, unavailable/disallowed models, invalid output or confidence below 0.75 fall back to the deterministic classifier. Interpretation never creates approval authority.
- Registered company names come from the membership-authorized business catalog. Optional aliases and descriptions come from the latest scoped `business-profile` entity. Exact names and aliases, descriptive phrases, active-business references and business switching are supported. Multiple matches produce a clarification before evidence retrieval or orchestration admission. No example business names are embedded in production routing.
- `owner_intents.payload` stores a thread ID, retry identity, user message, assistant answer, interpreted semantics and conversation-state snapshot. State includes active business/topic, current question, unresolved ambiguity, primary finding, proposals, selection, approval state and evidence references. These are additive JSON fields; no schema migration is required. Existing atomic intent/orchestration admission remains the write boundary.
- `GET /api/control/chat` restores the latest accessible thread; `?threadId=<uuid>` selects one. `POST` accepts `{message,threadId,channel:"chat"}` and an `Idempotency-Key`. It rejects client-supplied state or interpretation. The existing `/api/control/intents` endpoint remains available for the original owner-intent contract.
- Question-aware ranking runs after tenant, resource, freshness and sensitivity filtering. Revenue, infrastructure, marketing and customer topics prioritize corresponding records. General health includes representative areas. Answers state missing data/connection needs and do not assert a root cause from status records alone.
- The composer renders user/assistant history, supporting evidence, ongoing lifecycle states, exact-bound approval summaries and verification receipt references. Polling continues while work is nonterminal, retries on a fixed interval and cleans up on unmount. Messages remain in the composer after submission failures; retries retain their idempotency key.

## Business metadata

Company names are already registered in `companies`. To support an alias or description, register a `control_plane_entities` record with `entity_type = 'business-profile'`, the same portfolio/company scope, and a payload such as:

```json
{
  "environment": "staging",
  "sensitivity": "internal",
  "aliases": ["Warehouse Operations"],
  "description": "warehouse app for inventory and logistics"
}
```

Use the existing authorized registration/provisioning mechanism; chat does not create or update these profiles. There is no profile-editing UI in this change. Metadata must accurately describe the registered business. Matching is conservative and multiple matches ask the user to choose.

## Authorization and persistence boundaries

Every request authenticates the session and rechecks active organization, company and portfolio memberships. Each history read executes under that business's PostgreSQL tenant scope and filters user, environment and thread. Switching business reauthenticates the selected portfolio; model-supplied IDs cannot establish scope.

A per-user/thread advisory lock rejects overlapping submissions so a stale request cannot silently choose an action. Retry identity is persisted with each turn. No transcript is stored in browser local storage or audit metadata. Known credential patterns are redacted before storage/model transmission. Unstructured user language is conservatively classified as `SENSITIVE` for AI routing; semantic mode requires a validated STANDARD model explicitly eligible for that data class and environment. Budget and kill-switch checks use the existing gateway infrastructure. Without that eligibility, deterministic routing continues to work.

Clarification turns are answered records and enqueue no orchestration. Read-only investigation and recommendations use eligible stored evidence. An actionable selection is carried into the frozen planner input, with unselected proposals removed. This remains advisory input: existing validation, policy evaluation, decisions, fresh passkey requirements, scope/hash-bound grants, execution and independent verification still govern work.

Inline approvals use the existing decision PATCH endpoint and trusted session step-up. The UI renders an approval button only when a matching, integrity-checked public/internal plan summary is available. Otherwise it links to the decision review. It never accepts a model assertion of approval. Completion and verification references come from persisted orchestration state, not inferred success from a provider response. Approval state is rebuilt from authoritative decisions when reopening; verified work clears the old selected proposal.

## Acceptance checks

```bash
npm ci
npm run typecheck
npm run lint
npm run verify:architecture
npm test -- lib/conversation lib/control-api lib/intelligence/context.test.ts lib/orchestration/owner-intent-flow.test.ts lib/orchestration/authorization-flow.test.ts lib/domain/decision-service.test.ts
npm test -- --no-file-parallelism
npm run build
npx playwright install chromium
npm run test:e2e -- e2e/conversation.spec.ts
```

With a migrated, certificate-verified test PostgreSQL database configured, also run:

```bash
GETDONE_POSTGRES_INTEGRATION=true npm test -- lib/persistence/postgres/owner-intent-orchestration.integration.test.ts lib/persistence/postgres/orchestration-authorization.integration.test.ts
```

`lib/conversation/acceptance.test.ts` covers all conversational examples, dynamic custom names/aliases/descriptions, missing data, model fallback, post-verification state and filtering. `http.server.test.ts` covers authenticated restoration, foreign-user/environment exclusion, client-state injection, concurrent submissions and idempotent retry. The PostgreSQL integration test checks durable restoration using a newly constructed store and confirms answered turns do not enqueue execution. Existing decision/authorization tests prove exact approval hashes, fresh step-up, blocked actions and rejection of tampered bindings. Browser tests exercise restoration, inline scope headers, approval-to-verification presentation and failure recovery with mocked API responses; they do not claim live provider execution.

## Validation and remaining limits

- Full unit suite: 1,258 passed, 165 environment-dependent tests skipped before the final verified-work regression was added; the final focused conversation/approval suite passed all 83 tests, including the additional regressions. TypeScript, ESLint, architecture checks and a production build passed.
- PostgreSQL/live-provider acceptance was not run: no test database or live credentials were configured here. No production work was executed.
- Chromium installation failed because the downloaded archive was empty/corrupt. Browser acceptance tests are provided but were not executed in this environment.
- History retrieval currently returns the most recent 100 turns per business. Older turns remain persisted; pagination and multi-thread navigation are follow-up work.
- Evidence retrieval is bounded to 500 recent presentation records, seven days of freshness and six answer citations. This change does not add financial, marketing or support connectors or automatically fetch external diagnostics. Recommendations are conservative investigation/draft proposals, not model-generated strategic analysis.
- Explicit multi-business comparison is not implemented; the resolver asks the user to select a business rather than combine evidence.
- Business descriptions and aliases require registered profile metadata; arbitrary semantic similarity search over business descriptions is not implemented.
- The semantic call uses the existing budget snapshot/concurrency implementation. Stronger atomic AI-budget reservation is outside this change.
- Concurrent submissions reserve a database connection for the thread advisory lock; configure a pool of at least two connections (the existing default is ten). High-concurrency pooling and pagination need additional load testing.
- No deployment, merge, external publication or real provider mutation was performed.
