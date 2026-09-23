# Slack live staging acceptance

Requirement 12 uses a dedicated Slack staging workspace/channel and the existing governed GetDone Job path:

authoritative Job -> immutable execution spec -> durable PostgreSQL queue -> worker -> Business Action orchestrator -> Slack adapter -> provider-object verification -> durable outcome/evidence.

## Required Slack staging setup

Create a dedicated Slack app in a non-production workspace and install it into a dedicated public test channel.

The primary bot token needs:

- `chat:write`
- `channels:history` for provider-object verification in the public staging channel

Protected GitHub `staging` environment secrets:

- `SLACK_STAGING_BOT_TOKEN`
- `SLACK_STAGING_READ_TOKEN` (optional; when blank, the bot token is used for reads)
- `SLACK_STAGING_NO_WRITE_TOKEN` — a valid staging token intentionally lacking `chat:write`
- `SLACK_STAGING_REVOKED_TOKEN` — an intentionally revoked staging token

Protected GitHub environment variable:

- `SLACK_STAGING_CHANNEL_ID`

The app must be a member of the staging channel.

## Acceptance cases

The suite exercises:

- real `chat.postMessage`;
- deterministic `client_msg_id` derived from GetDone idempotency lineage;
- independent provider-object verification through Slack history;
- `chat.delete` cancellation plus independent deletion confirmation;
- controlled HTTP 429 followed by a safe real-provider retry;
- revoked-token failure;
- valid-token permission failure;
- real channel-not-found;
- restart/resume after provider acceptance without a second post.

The 429 is injected at the transport boundary so the suite does not intentionally exhaust a real workspace's API quota. All successful provider-object cases still create and verify real Slack messages.

Run:

```bash
npm run slack:accept-staging
```

Evidence is written to `test-results/slack-staging-acceptance.json`. Tokens are never written to the artifact.
