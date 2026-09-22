BEGIN;

CREATE TABLE IF NOT EXISTS ai_call_audits (
  id bigserial PRIMARY KEY,
  request_id text NOT NULL,
  correlation_id text NOT NULL,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  validation_status text NOT NULL,
  estimated_cost_cents numeric(18,6) NOT NULL CHECK (estimated_cost_cents >= 0),
  actual_cost_cents numeric(18,6) NOT NULL CHECK (actual_cost_cents >= 0),
  audit_hash text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_call_audits_scope_idx
  ON ai_call_audits (portfolio_id,company_id,recorded_at DESC);

CREATE TABLE IF NOT EXISTS ai_usage_records (
  usage_hash text PRIMARY KEY,
  request_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 1),
  profile_id text NOT NULL,
  gateway_id text NOT NULL,
  provider_id text NOT NULL,
  model_id text NOT NULL,
  input_tokens integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL CHECK (output_tokens >= 0),
  estimated_cost_cents numeric(18,6) NOT NULL CHECK (estimated_cost_cents >= 0),
  actual_cost_cents numeric(18,6) NOT NULL CHECK (actual_cost_cents >= 0),
  outcome text NOT NULL,
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  UNIQUE (request_id,attempt)
);
CREATE INDEX IF NOT EXISTS ai_usage_records_request_idx
  ON ai_usage_records (request_id,attempt);

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-22.1')
ON CONFLICT (version) DO NOTHING;

COMMIT;
