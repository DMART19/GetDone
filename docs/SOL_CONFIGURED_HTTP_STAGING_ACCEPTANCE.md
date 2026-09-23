# Configured HTTPS live staging acceptance

Requirement 13 is exercised against a controlled provider implemented by this repository and exposed through a real public HTTPS tunnel during the acceptance run.

This is not a fetch mock. The GetDone adapter connects over HTTPS through external DNS/TLS, while the staging provider remains deterministic and fully controlled by the acceptance workflow.

## Governed path

authoritative Job -> immutable execution spec -> PostgreSQL durable queue -> worker -> Business Action orchestrator -> configured HTTPS adapter -> public HTTPS endpoint -> optional verification/cancellation -> durable provider and verification evidence.

## Endpoint controls

The provider server:

- requires an ephemeral bearer credential;
- requires GetDone idempotency headers;
- stores a single provider record per idempotency lineage;
- exposes independent verification and cancellation surfaces;
- has a separate ephemeral control credential used only for inspection and credential rotation;
- never writes its bearer credentials into acceptance evidence.

The CI workflow generates all credentials at runtime. No external account or persistent secret is required.

## Acceptance cases

- normal configured HTTPS execution;
- consequential action with independent verification;
- configured cancellation;
- terminal 4xx;
- retryable 5xx followed by successful retry;
- slow response / timeout with same-lineage idempotent recovery;
- oversized response rejected by the streaming size guard;
- malicious provider operation ID rejected before unsafe lineage persistence/interpolation;
- real DNS/network failure against the reserved `.invalid` namespace;
- credential rotation: old credential rejected, rotated credential succeeds.

## Real HTTPS

The workflow starts the repository-owned provider on loopback, then exposes it through a Cloudflare Quick Tunnel. GetDone only receives the generated `https://*.trycloudflare.com` origin. This makes TLS, DNS, outbound networking, request cancellation, and response streaming part of the acceptance surface.

Run:

```bash
npm run http:accept-staging
```

Evidence is written to `test-results/configured-http-staging-acceptance.json`.
