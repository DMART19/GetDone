BEGIN;

ALTER TABLE ai_call_audits
  ADD COLUMN IF NOT EXISTS routing_policy_version text,
  ADD COLUMN IF NOT EXISTS selected_profile_id text,
  ADD COLUMN IF NOT EXISTS actual_profile_id text,
  ADD COLUMN IF NOT EXISTS gateway_id text,
  ADD COLUMN IF NOT EXISTS provider_id text,
  ADD COLUMN IF NOT EXISTS model_id text,
  ADD COLUMN IF NOT EXISTS fallback_used boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fallback_reason text,
  ADD COLUMN IF NOT EXISTS latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  ADD COLUMN IF NOT EXISTS input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  ADD COLUMN IF NOT EXISTS output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  ADD COLUMN IF NOT EXISTS failure_class text;

UPDATE ai_call_audits
SET
  routing_policy_version = COALESCE(routing_policy_version, payload->>'routingPolicyVersion'),
  selected_profile_id = COALESCE(selected_profile_id, payload->>'selectedProfileId'),
  actual_profile_id = COALESCE(actual_profile_id, payload->>'actualProfileId'),
  gateway_id = COALESCE(gateway_id, payload->>'gatewayId'),
  provider_id = COALESCE(provider_id, payload->>'providerId'),
  model_id = COALESCE(model_id, payload->>'modelId'),
  fallback_used = COALESCE((payload->>'fallbackUsed')::boolean, fallback_used),
  fallback_reason = COALESCE(fallback_reason, payload->>'fallbackReason'),
  latency_ms = COALESCE(latency_ms, NULLIF(payload->>'latencyMs','')::integer),
  input_tokens = COALESCE(input_tokens, NULLIF(payload->>'inputTokens','')::integer),
  output_tokens = COALESCE(output_tokens, NULLIF(payload->>'outputTokens','')::integer),
  failure_class = COALESCE(failure_class, payload->>'failureClass');

ALTER TABLE ai_usage_records
  ADD COLUMN IF NOT EXISTS correlation_id text,
  ADD COLUMN IF NOT EXISTS portfolio_id text,
  ADD COLUMN IF NOT EXISTS company_id text,
  ADD COLUMN IF NOT EXISTS environment text,
  ADD COLUMN IF NOT EXISTS latency_ms integer NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  ADD COLUMN IF NOT EXISTS failure_class text;

UPDATE ai_usage_records
SET
  correlation_id = COALESCE(correlation_id, payload->>'correlationId'),
  portfolio_id = COALESCE(portfolio_id, payload->>'portfolioId'),
  company_id = COALESCE(company_id, payload->>'companyId'),
  environment = COALESCE(environment, payload->>'environment'),
  latency_ms = COALESCE(NULLIF(payload->>'latencyMs','')::integer, latency_ms),
  failure_class = COALESCE(failure_class, payload->>'failureClass');

CREATE INDEX IF NOT EXISTS ai_usage_records_scope_idx
  ON ai_usage_records (portfolio_id,company_id,recorded_at DESC);

CREATE TABLE IF NOT EXISTS ai_gateway_runtime_configs (
  config_hash text PRIMARY KEY,
  config_version text NOT NULL,
  routing_policy_version text NOT NULL,
  provider_id text NOT NULL,
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_gateway_runtime_configs_version_idx
  ON ai_gateway_runtime_configs (config_version,recorded_at DESC);

CREATE TABLE IF NOT EXISTS ai_gateway_canary_runs (
  evidence_hash text PRIMARY KEY,
  canary_id text NOT NULL UNIQUE,
  config_hash text NOT NULL REFERENCES ai_gateway_runtime_configs(config_hash),
  gateway_id text NOT NULL,
  provider_id text NOT NULL,
  model_id text NOT NULL,
  ok boolean NOT NULL,
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_gateway_canary_runs_observed_idx
  ON ai_gateway_canary_runs (observed_at DESC);

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-22.4')
ON CONFLICT (version) DO NOTHING;

COMMIT;
