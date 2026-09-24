# Credential rotation and production observability

Date: 2026-09-24

## Requirement 16 — credential rotation semantics

Credential rotation is evaluated at the moment of each provider network call. Persisted Jobs and execution specs never contain provider secret material.

### Resume matrix

| Provider | Queued | Claimed | Accepted | Verification pending |
| --- | --- | --- | --- | --- |
| Gmail | latest active version | latest active version | preserve Gmail provider object ID; verify with latest active version | preserve provider object ID; verify with latest active version |
| Slack | latest active version | latest active version | preserve channel/timestamp operation ID; read/delete with latest active version | preserve operation ID; read/delete with latest active version |
| Configured HTTPS | latest active version | latest active version | preserve provider operation ID; status/cancel with latest active version | preserve provider operation ID; status/cancel with latest active version |
| Webhook | latest active version | latest active version | preserve provider operation ID; verify/cancel with latest active version | preserve provider operation ID; verify/cancel with latest active version |
| OpenRouter | latest active version | latest active version | not applicable | not applicable |

OpenRouter model calls are synchronous in the current GetDone execution model. There is no durable accepted provider operation that is resumed later. The adapter resolves the current credential before every HTTP attempt, so a retry after rotation uses the newly active version.

### Version evidence

Credential leases record the credential rotation version active when the lease was issued. Broker redemption may return the same or a newer version, never an older one. Every broker usage audit records the actual version redeemed.

This gives the deterministic rule:

- the lease binds identity, provider, scope, Resource, Job, capability, and minimum credential version;
- the broker chooses the newest active eligible credential at provider-call time;
- provider operation identity remains pinned after acceptance;
- credential material does not remain pinned after acceptance;
- rotation therefore does not require replaying a successful side effect.

The acceptance test is `lib/credentials/credential-rotation.integration.test.ts`.

## Requirement 17 — production observability foundation

GetDone now has a structured observability layer with:

- JSON structured logs;
- trace/span context propagated with AsyncLocalStorage;
- OTLP-compatible JSON HTTP export for logs, metrics, and traces;
- fail-open telemetry emission so collector outages cannot fail governed Jobs;
- low-cardinality semantic attributes for provider, operation, capability, retry class, environment, worker, and outcome.

### Instrumented lifecycle

The minimum production path now includes:

- Job enqueue and durable enqueue persistence;
- atomic Job claim;
- Job execute;
- worker heartbeat age;
- provider execute/status/cancel calls and latency;
- PostgreSQL query and transaction latency;
- AI calls, latency, token counts, model/provider identity;
- authorization denials;
- provider retry classes;
- Job retry counts;
- dead-letter counts;
- verification-pending age;
- credential redemption version.

### Production configuration

Production runtime validation requires:

```
GETDONE_OBSERVABILITY_ENABLED=true
GETDONE_OTEL_EXPORTER_OTLP_ENDPOINT=https://<collector>
```

Optional OTLP HTTP headers:

```
GETDONE_OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <collector-token>
```

The endpoint must be HTTPS in production. JSON telemetry is also emitted to stdout for platform log collection.

### Metric names

- `getdone.job.enqueue.total`
- `getdone.job.ready.count`
- `getdone.job.execution.total`
- `getdone.job.retry.total`
- `getdone.job.dead_letter.total`
- `getdone.worker.heartbeat.age`
- `getdone.worker.cycle.total`
- `getdone.provider.call.duration`
- `getdone.provider.call.total`
- `getdone.provider.result.total`
- `getdone.verification.pending.age`
- `getdone.db.query.duration`
- `getdone.db.transaction.duration`
- `getdone.ai.call.duration`
- `getdone.ai.call.total`
- `getdone.ai.tokens.input`
- `getdone.ai.tokens.output`
- `getdone.authorization.denial.total`
- `getdone.credential.redeem.total`

No credential material, provider response body, or sensitive Job payload is emitted as a metric/log attribute.
