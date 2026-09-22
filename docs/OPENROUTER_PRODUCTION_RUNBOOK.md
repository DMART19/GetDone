# GetDone OpenRouter Production Runbook

This runbook covers the governed OpenRouter AI Gateway. The model proposes; GetDone validates, authorizes, creates authoritative Jobs, executes, and verifies.

## Authority boundary

Allowed:

```text
detection
→ AI proposal
→ deterministic schema validation
→ policy / budget / kill switch checks
→ owner/authorization path
→ authoritative Grant + consumption + Task + Job
→ durable execution worker
→ verification
```

Forbidden:

```text
AI response → provider/business side effect
```

The AI Gateway does not receive authority to invent portfolio/company scope, grants, approval proofs, credentials, Jobs, or external side effects.

## Server-side secrets

Store these only in the deployment or CI secret store:

```text
OPENROUTER_API_KEY=<secret>
GETDONE_INTERNAL_AI_TOKEN=<secret>
```

Never commit either value and never expose them through `NEXT_PUBLIC_*`.

For GitHub live acceptance, create the repository/environment secret named exactly:

```text
OPENROUTER_API_KEY
```

The workflow references it as `${{ secrets.OPENROUTER_API_KEY }}` and fails closed if it is absent.

## Approved runtime configuration

```text
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_TIMEOUT_MS=20000
OPENROUTER_MAX_RETRIES=2
OPENROUTER_RETRY_BASE_DELAY_MS=250
OPENROUTER_CANARY_ENABLED=true
OPENROUTER_CANARY_MODEL=openai/gpt-5.6-luna
OPENROUTER_APP_TITLE=GetDone
```

The runtime rejects arbitrary OpenRouter paths/hosts. The EU `/api/v1` endpoint is also accepted by the adapter when explicitly configured.

Production/staging use versioned model/routing configuration from `lib/ai-gateway/production-config.ts`. Optional JSON overrides must supply profiles and policy together and must match the current configuration version exactly.

## Routing

Current policy version: `2026-09-22.1`.

- LIGHTWEIGHT → Luna
- STANDARD → Luna, then Sol fallback
- HIGH_REASONING → Sol
- CODING → Sol
- VISION → Luna, then Sol
- LONG_CONTEXT → Luna, then Sol

Profiles require validated health, environment/data-class eligibility, context capacity, requested modality, structured-output/tool capability, latency class, cost ceiling, budget availability, and no blocking kill switch.

`DETERMINISTIC` work is forbidden from invoking a model.

## Data handling and usage

OpenRouter requests ask for usage accounting and set provider data collection to deny. Each model attempt persists:

- request/correlation/scope;
- attempt number;
- selected profile;
- gateway/provider/model identity;
- input/output tokens;
- estimated and provider-reported/fallback-calculated cost;
- latency;
- schema/model-identity/failure outcome.

The final call audit persists routing policy version, selected/actual model profile, fallback reason, total cost, tokens, latency, and validation result.

## Canary

The concrete canary uses `openai/gpt-5.6-luna`. It must return exactly `GETDONE_CANARY_OK` and the returned model identity must equal the requested canary model.

Authorized infrastructure can invoke:

```http
POST /api/internal/ai/canary
Authorization: Bearer <GETDONE_INTERNAL_AI_TOKEN>
```

Successful canaries persist both the immutable runtime configuration hash and canary evidence to PostgreSQL.

## Acceptance

`.github/workflows/openrouter-live.yml` runs against PostgreSQL 16 and a real OpenRouter key. It must prove:

1. a real OpenRouter request returns a structured business proposal;
2. schema validation succeeds;
3. full audit/usage data is persisted;
4. no external action is invoked by the AI proposal;
5. only a separately supplied authoritative Grant/consumption/Job permits enqueue;
6. the concrete live canary passes and is persisted;
7. application runtime reset does not lose prior AI audit evidence.

Normal unit/CI coverage separately proves schema-invalid output, timeout, 429, HTTP 500, invalid credential, fallback, returned-model mismatch, budget exhaustion, kill switch, deterministic no-model behavior, and stale routing rejection.

## Connectivity truth

A passing live CI provider test proves real OpenRouter connectivity from the acceptance environment. It does **not** by itself prove that a staging or production GetDone deployment has the provider secret installed.

Keep staging/production `connections.aiGateway=false` until the deployed environment itself passes the canary and proposal acceptance.
