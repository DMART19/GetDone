# Operational alerts and end-to-end correlation lineage

Date: 2026-09-24

## Requirement 18 — operational alert rules

The authoritative machine-readable registry is:

`config/operational-alert-rules.json`

Schema/evaluator:

`lib/observability/alert-rules.ts`

The registry contains ten versioned rules:

| Rule | Warning | Critical | Window |
| --- | ---: | ---: | ---: |
| worker offline | heartbeat age >= 120s | >= 300s | 120s |
| queue depth | >= 250 ready Jobs | >= 750 | 300s |
| dead-letter count | >= 1 | >= 5 | 900s |
| database unavailable | availability <= 0 | <= 0 | 30s |
| backup stale | age >= 18h | >= 24h | 300s |
| verification backlog | >= 25 | >= 100 | 300s |
| AI provider failure rate | >= 10% | >= 25% | 300s |
| integration failure rate | >= 10% | >= 25% | 300s |
| authorization failure spike | >= 20 | >= 50 | 300s |
| resource-agent disconnect | connected <= 0 | <= 0 | 120s |

Each rule declares its metric, aggregation kind, unit, evaluation window, warning and critical comparator/value, allowed grouping labels, and runbook path.

The registry is validated for:
- exactly ten required operational conditions;
- unique rule IDs;
- a distinct machine metric for every rule;
- finite numeric thresholds;
- deterministic warning/critical evaluation.

## Requirement 19 — correlation-ID propagation

A server-generated correlation ID is treated as immutable execution lineage.

The intended persisted path is:

`owner request → Control API → Decision → Plan → Task → Job → queue → worker → provider call → verification → audit event → final owner result`

### Propagation rules

- The Control API creates one correlation ID at the HTTP boundary and returns it in the API envelope and `x-correlation-id` header.
- Owner-intent persistence records that same ID.
- Authoritative entities retain their original correlation lineage across later transitions; a later command cannot silently replace it.
- Tasks and Jobs created from authoritative commands persist the correlation ID.
- Production Job dispatch fails closed when persisted correlation lineage is missing.
- The immutable Job execution spec and durable queue envelope carry the same ID.
- Workers read correlation lineage from the queue envelope.
- Provider execution records inherit the authorized request correlation ID.
- Verification evidence and receipts retain the same lineage.
- Domain audit events use the entity lineage correlation ID.
- Durable Job outcomes/runtime events carry the queue correlation ID.
- Final owner Job result/view surfaces the same correlation ID.

### PostgreSQL reconstruction

Migration `2026-09-24.1_correlation_lineage.sql` creates correlation expression indexes over authoritative runtime storage.

`PostgresCorrelationLineageStore.reconstruct(correlationId)` requires only one correlation ID. It searches:
- owner intents;
- authoritative Decision/Plan/Task/Job records;
- durable queue state;
- worker lease;
- provider execution;
- provider verification evidence;
- audit ledger;
- final Job result.

The result is normalized to eleven required stages and reports any missing stage.

### Acceptance evidence

`lib/observability/correlation-lineage-postgres.integration.test.ts` creates a migrated PostgreSQL database, persists a complete execution plus unrelated noise, and reconstructs the complete eleven-stage execution using only the target correlation ID.

The unrelated execution must not appear in the reconstructed result.

The PostgreSQL acceptance workflow runs this test alongside migration, RLS, Control API, durable worker, backpressure, dead-letter, crash/restart, and WebAuthn acceptance.
