# Gmail live staging acceptance

Requirement 11 uses a dedicated Gmail staging account and the real governed GetDone Job path:

authoritative Job -> immutable execution spec -> durable PostgreSQL queue -> worker -> routed business action -> Gmail adapter -> provider-object verification -> durable outcome/evidence.

The ordinary PR suite does not need Gmail credentials. Live acceptance is a manually dispatched, protected `staging` GitHub Actions workflow.

## Required protected staging configuration

GitHub environment secrets:

- `GMAIL_STAGING_CLIENT_ID`
- `GMAIL_STAGING_CLIENT_SECRET`
- `GMAIL_STAGING_REFRESH_TOKEN`
- `GMAIL_STAGING_REVOKED_TOKEN` — a deliberately revoked/expired disposable Gmail access token kept only for the revoked-credential acceptance case.

GitHub environment variable:

- `GMAIL_STAGING_EMAIL` — the dedicated Gmail account address; messages are sent to itself.

The OAuth grant used by the refresh token must include Gmail send and readonly scopes. The workflow mints a short-lived access token at runtime. No Gmail token is committed or uploaded as an artifact.

## Duplicate/ambiguous-send safety

Gmail does not provide GetDone with a native exactly-once idempotency key for `messages.send`. The adapter therefore places a deterministic RFC Message-ID in every governed message and, when provider-object verification is enabled, searches Gmail for that Message-ID before sending.

If the send transport times out after Gmail may have accepted the message, or Gmail returns a successful HTTP response whose body is malformed, GetDone persists a synthetic provider operation keyed by that RFC Message-ID and performs read-only provider lookup. It does not blindly issue a second send.

## Live cases

The staging suite covers:

- real governed send and independent provider-object verification;
- duplicate idempotent enqueue -> one Gmail object;
- timeout-after-send -> provider lookup recovery, one POST;
- runtime restart after provider acceptance -> persisted status resume, no resend;
- invalid token -> dead letter, no provider object;
- deliberately revoked token -> dead letter, no provider object;
- Gmail-shaped HTTP 429 -> controlled transport fault, then safe same-lineage retry;
- malformed response after real Gmail acceptance -> Message-ID recovery, no resend;
- verification failure after a real send -> Job dead-letters even though independent Gmail evidence confirms the object exists.

The 429 is intentionally fault-injected around the live Gmail transport rather than produced by deliberately exhausting Google quota. The provider-object cases are real Gmail operations; the acceptance artifact marks whether a fault came from Gmail or from the controlled transport wrapper.

Run:

```bash
npm run gmail:accept-staging
```

Evidence is written to `test-results/gmail-staging-acceptance.json` and contains provider object IDs/hashes and counts, never OAuth secrets.
