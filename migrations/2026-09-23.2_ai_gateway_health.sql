BEGIN;

CREATE TABLE IF NOT EXISTS ai_gateway_canary_events (
  id text PRIMARY KEY,
  environment text NOT NULL CHECK (environment IN ('development','staging','production')),
  routing_policy_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('success')),
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  observed_at timestamptz NOT NULL,
  evidence_hash text NOT NULL UNIQUE,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_gateway_canary_environment_observed_idx
  ON ai_gateway_canary_events (environment, observed_at DESC);

CREATE TABLE IF NOT EXISTS ai_budget_health_snapshots (
  snapshot_hash text PRIMARY KEY,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  period text NOT NULL,
  company_remaining_cents numeric NOT NULL CHECK (company_remaining_cents >= 0),
  portfolio_remaining_cents numeric NOT NULL CHECK (portfolio_remaining_cents >= 0),
  active_concurrent_calls integer NOT NULL CHECK (active_concurrent_calls >= 0),
  concurrency_limit integer NOT NULL CHECK (concurrency_limit >= 1),
  snapshot_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_budget_health_scope_recorded_idx
  ON ai_budget_health_snapshots (portfolio_id, company_id, recorded_at DESC);

ALTER TABLE ai_budget_health_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_budget_health_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON ai_budget_health_snapshots;
CREATE POLICY getdone_tenant_isolation ON ai_budget_health_snapshots
  USING (getdone_tenant_scope_matches(portfolio_id, company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id, company_id));

ALTER TABLE ai_call_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_call_audits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON ai_call_audits;
CREATE POLICY getdone_tenant_isolation ON ai_call_audits
  USING (getdone_tenant_scope_matches(portfolio_id, company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id, company_id));

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-23.2')
ON CONFLICT (version) DO NOTHING;

COMMIT;
