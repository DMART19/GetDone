# Webhook live staging acceptance

Requirement 14 runs against a repository-owned webhook receiver exposed through real external HTTPS/DNS.

The receiver verifies an HMAC-SHA256 signature before accepting delivery, captures only hashes and provider metadata, deduplicates by GetDone's idempotency key, exposes an independent verification endpoint, and supports configured cancellation.

## Credential model

Requirement 15 is part of this acceptance path.

The Job and persisted execution spec contain only a `credentialLeaseId`. The credential lease is stored in PostgreSQL under tenant RLS. Immediately before each provider execute/status/cancel call, the governed credential broker validates the lease and redeems its opaque `deliveryRef` into short-lived scoped material. Only that in-memory material is passed to the adapter.

The acceptance test explicitly checks that the HMAC signing secret does not appear in:

- credential lease payloads;
- credential usage audit payloads;
- Job execution specs;
- business-action execution records.

## Live cases

The suite exercises:

- signed delivery over real HTTPS;
- independent verification;
- timeout-after-accept followed by same-idempotency duplicate suppression;
- configured cancellation;
- tampered provider response / malicious operation lineage;
- retry exhaustion;
- restart after provider acceptance without redelivery.

The workflow generates ephemeral signing/control material at runtime. No persistent external credentials are required.

Run:

```bash
npm run webhook:accept-staging
```

Evidence is written to `test-results/webhook-staging-acceptance.json`.
