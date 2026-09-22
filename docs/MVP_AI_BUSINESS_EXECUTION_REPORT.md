# MVP AI Gateway and Business Execution

Date: 2026-09-22

## Delivered scope

This tranche connects the existing provider-neutral AI and durable Job contracts into a production-configurable MVP runtime without reopening physical-compute work.

### AI Gateway

- OpenRouter remains behind the GetDone-owned `AIGatewayAdapter` boundary.
- Model profiles and role routes load from server-only validated configuration.
- Routing applies capability, modality, tool, structured-output, context, data-class, environment, latency, budget, health, validation, pin/exclusion, and kill-switch gates before preference order.
- Multiple gateway adapters can be registered and eligible fallback remains policy-bound.
- Timeout and transport/HTTP retry behavior remains in the OpenRouter adapter.
- Every attempted model call records token usage, estimated cost, actual/provider cost when available, model/provider identity, latency, validation outcome, and failure class.
- Final call audits and per-attempt usage records persist to PostgreSQL.
- Structured output is schema-validated before it can become a proposal.
- `DETERMINISTIC` work still cannot invoke a model.

AI output remains non-authoritative. The new MVP workflow can create a hash-bound proposal only; it cannot queue execution until it receives an authoritative queued Job with exact Grant and Task-consumption lineage.

### Real business execution path

The first concrete production adapter is a configured HTTPS operation behind the `http.request` capability:

1. A detection is supplied to the MVP workflow.
2. The AI Gateway returns a schema-valid proposal.
3. GetDone's existing Decision, Approval/Authorization, Task, and Job services establish authority.
4. The workflow verifies the queued Job, Grant hash, Task authorization-consumption hash, proposal hash, capability, input hash, and scope.
5. The dispatcher re-reads the Job from authoritative PostgreSQL storage, rejects any caller-supplied snapshot mismatch, and durably stores the execution spec before enqueueing it.
6. The durable worker resolves `http.request` to the configured HTTPS adapter.
7. The adapter calls only the server-configured URL, sends idempotency and Job lineage headers, and never accepts a target URL from model/Job payload.
8. The response is size-bounded, hashed, schema-validated, persisted as execution evidence, and converted into durable outcome/event records.
9. The owner view derives a secure notification/deep link from durable outcome truth.

The adapter cannot mutate authoritative Job state; it returns evidence and `jobStateMutationApplied: false` exactly like the existing authority model requires.

### Resource-agnostic dispatch

The capability registry now includes:

- `http.request`
- `browser.execution`
- `code.execution`
- `scheduled.worker`

Jobs and adapter bindings use these capabilities. Machine names such as `raspberryPi5` are not dispatch capabilities. Today `http.request` can run through a cloud worker; future browser, code, local server, Pi, Mac, GPU, and cluster executors can be installed behind the same registry without changing Job authority.

## Production configuration

Required server-only settings for the AI path:

- `OPENROUTER_API_KEY`
- `GETDONE_AI_MODEL_PROFILES_JSON`
- `GETDONE_AI_ROUTING_POLICY_JSON`

Required server-only settings for the first business action path:

- `GETDONE_HTTP_ACTIONS_JSON`
- any credential environment variable named by an operation's `authorizationEnv`
- `GETDONE_INTERNAL_WORKER_TOKEN`

`GETDONE_HTTP_ACTIONS_JSON` contains operation names and fixed HTTPS endpoints. Raw credentials are referenced by environment-variable name and are never embedded in the action payload, model prompt, frontend, or repository.

## Release truth

The code is runtime-wired and CI-testable, but this repository does not claim that a real OpenRouter key, PostgreSQL deployment, worker schedule, or external business endpoint has been provisioned. Release status is therefore `runtime-wired-unconnected` / `implemented-unconfigured`, not production accepted.

Phase 28 physical compute remains frozen and deferred.
