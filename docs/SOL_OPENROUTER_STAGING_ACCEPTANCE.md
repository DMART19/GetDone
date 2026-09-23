# OpenRouter staging acceptance

GetDone now has a secret-backed staging acceptance workflow for the existing OpenRouter AI Gateway.

## Command

The workflow runs:

```bash
npm run ai:accept-staging
```

with `GETDONE_OPENROUTER_STAGING_ACCEPTANCE=true`.

## Required staging environment configuration

The GitHub `staging` environment must provide:

- secret `OPENROUTER_API_KEY`
- variable `OPENROUTER_PRIMARY_MODEL`
- variable `OPENROUTER_FALLBACK_MODEL`

The two model IDs must be distinct, concrete model IDs. Do not use `openrouter/auto`, aliases with loose matching, or approximate model selectors when production identity verification matters.

## Acceptance coverage

Live-provider evidence is required for:

- primary model execution
- fallback model execution after a deliberately invalid primary operation
- concrete-model canary
- runtime reconstruction/restart
- PostgreSQL AI usage and call-audit persistence

Deterministic fault injection runs through the same OpenRouter adapter/gateway code for failure modes that cannot be safely or reliably induced against a real provider on demand:

- timeout
- HTTP 429
- HTTP 500
- malformed structured output
- returned-model identity mismatch

Local policy acceptance proves:

- budget exhaustion blocks before provider dispatch
- provider kill switch blocks before provider dispatch

The workflow writes `test-results/openrouter-staging-acceptance.json` and uploads it as a GitHub Actions artifact.

## Production truth

Repository implementation of the staging acceptance harness does not prove live connectivity. The release registry must remain `runtime-wired-unconnected` / `implemented-unconfigured` until the secret-backed workflow has actually completed successfully with a real OpenRouter staging credential. A missing secret or missing model variables is a failed acceptance, not a skipped success.
