# Sol Runtime Tranche — PostgreSQL Persistence, Durable Jobs, Business Actions, Software Worker

## Scope

This tranche implements production-grade runtime infrastructure behind the deterministic contracts already present in GetDone. It deliberately does **not** claim that a production database, provider credential, business API, or software deployment provider is connected.

## Database choice

GetDone now standardizes production authoritative persistence on **PostgreSQL 16+**.

The implementation uses plain SQL plus the `pg` driver instead of binding domain services to a vendor SDK. The same persistence layer can therefore run on managed PostgreSQL services such as Supabase Postgres, Neon, RDS, or on self-hosted PostgreSQL, subject to deployment-specific networking/TLS configuration.

## Production persistence adapters

Migration `2026-09-21.1_authority_runtime.sql` defines durable tables and constraints for:

- authoritative control-plane entities;
- idempotency claims/results;
- append-only audit events;
- authorization grants and single authoritative consumption;
- verification receipts;
- verified Job start/completion bridge facts;
- capacity ledgers, reservations, and atomic commit lineage;
- durable Job runtime state, leases, transactions, retries, dead letters, and recovery;
- durable Job execution specifications;
- business-action execution state;
- software-worker pipeline state.

The adapter layer includes:

- serializable PostgreSQL transaction boundaries;
- transaction-scoped entity, audit, and idempotency stores;
- version compare-and-swap entity persistence;
- immutable/hash-checked authorization replay behavior;
- authoritative verification/Job bridge reads;
- atomic reservation ledger + reservation commits;
- CAS-persisted business-action and software-worker runtime state.

## Durable Job runtime

`PostgresDurableJobStore` is a durable-external, restart-safe, multi-process-safe implementation of the existing `DurableJobStore` contract.

`DurableJobWorker` adds:

- ready-work discovery without treating discovery as authority;
- atomic leased claims;
- periodic/manual heartbeats;
- lease renewal;
- compare-and-swap release/cancellation;
- exponential retry scheduling;
- configured retry exhaustion to dead letter;
- expired-lease recovery;
- `FOR UPDATE ... SKIP LOCKED` recovery coordination across multiple workers;
- durable recovery, retry, dead-letter, and transaction lineage.

An active lease is closed before retry, cancellation, or dead-letter terminalization so a second active lease cannot remain orphaned.

## Business-action execution

`BusinessActionExecutionOrchestrator` runs authorized business side effects only through an installed capability-specific `BusinessActionAdapter`.

It:

- validates authorization/input/idempotency lineage before dispatch;
- persists provider operation identity;
- validates adapter/result/status identity;
- resumes an already-accepted provider operation without re-sending the side effect;
- polls bounded provider status;
- supports provider cancellation when available;
- emits Verification evidence for independently evaluable terminal results;
- never mutates authoritative Job success merely because a provider reports success.

No real email/CRM/payment/etc. business provider adapter is connected by this tranche.

## Software-worker runtime

`SoftwareWorkerRuntime` turns the existing Phase 21 contracts into a resumable pipeline:

inspect → isolated branch → modify → static analysis → tests → security → preview → staging → staging verification → production approval → deployment → post-deployment verification.

It persists runtime state between every governed phase and:

- requires non-empty static/test/security evidence;
- builds hash-bound `SoftwareChangeEvidence`;
- stops at the explicit production approval boundary;
- requires the exact persisted promotion receipt before deployment;
- keeps deployment-provider acceptance non-authoritative;
- requires independent post-deployment verification before success;
- supports rollback only after production deployment and only when rollback tooling/reference exists.

Actual Git/repository tooling and the production deployment executor remain injected adapters; this runtime does not bypass those authority boundaries.

## Durable execution routing

A hash-bound `JobExecutionSpec` is persisted separately from queue envelopes.

`RoutedJobExecutionHandler` connects durable Jobs to:

- authorized business-action execution;
- software preparation;
- software production deployment;
- software post-deploy verification;
- software rollback.

The queue therefore remains generic while execution specifications remain durable, typed, integrity-checked, and resumable.

## Production truth

Implemented:

- PostgreSQL schema/migrations;
- PostgreSQL transaction manager and authority stores;
- reservation persistence;
- durable Job Store;
- durable worker lifecycle;
- Job execution-spec persistence;
- business-action orchestration;
- software-worker orchestration;
- execution routing.

Still unconnected:

- a deployed production PostgreSQL instance / `DATABASE_URL`;
- production auth/session provider;
- actual business provider adapters;
- actual production software deployment executor;
- live production Job worker process/service deployment;
- production Phase 44 end-to-end acceptance evidence.

These remain release blockers rather than being represented by development mocks.
