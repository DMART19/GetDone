# Sol Production-Readiness Tranche — CI Security, Control API, OpenRouter

## Scope

This tranche implements three bounded improvements without upgrading any unconnected infrastructure to production-ready status.

## 1. CI and release security

CI now:

- runs on the Node 24 generation of official GitHub actions;
- disables checkout credential persistence;
- disables automatic npm package-manager caching for the privileged verification job;
- installs dependencies with lifecycle scripts disabled;
- runs a production dependency audit that fails on high/critical vulnerabilities;
- runs a full dependency-graph audit that fails on critical vulnerabilities;
- scans Git-tracked text sources for provider keys, GitHub/AWS/Slack/Stripe/Google/npm credentials, private keys, bearer credentials, and secret-like assignments;
- keeps environment files out of Git except the explicit example;
- publishes machine-readable dependency-audit evidence;
- publishes Vitest V8 and Playwright JSON evidence;
- requires all executable quality/security evidence before release generation;
- hashes those evidence files plus the CI workflow into the generated release manifest;
- enables weekly Dependabot checks for npm and GitHub Actions.

The release verifier fails if the workflow, quality evidence, security evidence, registry, environment manifest, package lock, source evidence, or generated manual no longer matches the release manifest.

## 2. Adapter-backed Control API

Control API surface version: **1.0.0**.

The HTTP surface now covers:

- owner chat/intents;
- Decision list/read and authoritative approve/modify/reject mutations;
- Resource list/read and authoritative Resource Registry discovery;
- governed Resource Enrollment start/read/list/action progression;
- Job list/read and owner-safe result views;
- Verification list/read;
- Control API health.

Authority rules:

- HTTP routes do not own persistence.
- All authenticated work flows through a replaceable `ControlApiApplicationAdapter`.
- The service-backed adapter uses the existing auth guard, trusted scope, Decision authority service, Resource Registry service, and Resource Enrollment service.
- Decision strong approval can consume only a server-resolved `StepUpProof`; proof objects are never accepted from request JSON.
- Mutating HTTP calls require an `Idempotency-Key`.
- Cross-company entity reads fail as not found.
- Resource discovery is constrained to the trusted environment and starts PUBLIC-only.
- Resource Enrollment remains a separate state machine; it is not treated as equivalent to registry discovery.
- The default runtime adapter is deliberately unavailable. Until production auth and persistence adapters are installed, protected Control API requests fail closed.

## 3. OpenRouter adapter

OpenRouter adapter version: **1.0.0**.

The provider adapter behind the existing `AIGatewayAdapter` interface now implements:

- server-only Bearer credential handling;
- approved HTTPS OpenRouter base hosts;
- OpenAI-compatible chat-completion request normalization;
- text and structured-output response normalization;
- actual response model propagation so the existing AI Gateway can reject model identity drift;
- profile gateway/provider binding checks;
- request timeout enforcement;
- bounded retry with exponential backoff for retryable HTTP and transport failures;
- `Retry-After` handling;
- non-retry behavior for authentication failures;
- optional app attribution headers;
- optional metadata headers;
- concrete-model canary configuration;
- canary response-content and model-identity verification.

The adapter exists in source, but runtime state remains **not connected** until a real `OPENROUTER_API_KEY`, active routing policy, concrete canary model, and deployment configuration are supplied.

## Production truth

This tranche does not claim:

- production authentication;
- production database/RLS/transaction persistence;
- a connected Control API application adapter;
- an active OpenRouter credential;
- an active AI routing policy;
- a passing live OpenRouter canary;
- a durable distributed Job Store;
- production end-to-end acceptance.

Those remain explicit release blockers rather than development mocks.
