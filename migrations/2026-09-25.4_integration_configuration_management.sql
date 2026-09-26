BEGIN;

CREATE TABLE IF NOT EXISTS integration_configurations (
  id text PRIMARY KEY,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development','staging','production')),
  provider_id text NOT NULL,
  kind text NOT NULL,
  display_name text NOT NULL,
  adapter_id text NOT NULL,
  adapter_version text NOT NULL,
  credential_binding_id text,
  capability_names text[] NOT NULL DEFAULT '{}',
  requested_scopes text[] NOT NULL DEFAULT '{}',
  granted_scopes text[] NOT NULL DEFAULT '{}',
  state text NOT NULL CHECK (state IN ('configured','connected','disabled','revoked')),
  health text NOT NULL CHECK (health IN ('unverified','healthy','degraded','unavailable','disabled','revoked')),
  last_verified_at timestamptz,
  last_verification_evidence_hash text CHECK (
    last_verification_evidence_hash IS NULL
    OR last_verification_evidence_hash ~ '^[a-f0-9]{64}$'
  ),
  disabled_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  record_hash text NOT NULL CHECK (record_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS integration_configurations_scope_idx
  ON integration_configurations(portfolio_id,company_id,environment,state,updated_at DESC);

CREATE INDEX IF NOT EXISTS integration_configurations_provider_idx
  ON integration_configurations(provider_id,company_id,environment);

CREATE TABLE IF NOT EXISTS integration_configuration_commands (
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  integration_id text NOT NULL REFERENCES integration_configurations(id),
  result_record_hash text NOT NULL CHECK (result_record_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (portfolio_id,company_id,idempotency_key)
);

CREATE TABLE IF NOT EXISTS integration_verification_evidence (
  evidence_hash text PRIMARY KEY CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  integration_id text NOT NULL REFERENCES integration_configurations(id),
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development','staging','production')),
  provider_id text NOT NULL,
  adapter_id text NOT NULL,
  adapter_version text NOT NULL,
  verified boolean NOT NULL,
  health text NOT NULL CHECK (health IN ('healthy','degraded','unavailable')),
  granted_scopes text[] NOT NULL DEFAULT '{}',
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS integration_verification_evidence_integration_idx
  ON integration_verification_evidence(integration_id,observed_at DESC);

ALTER TABLE integration_configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_configurations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON integration_configurations;
CREATE POLICY getdone_tenant_isolation ON integration_configurations
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));

ALTER TABLE integration_configuration_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_configuration_commands FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON integration_configuration_commands;
CREATE POLICY getdone_tenant_isolation ON integration_configuration_commands
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));

ALTER TABLE integration_verification_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_verification_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON integration_verification_evidence;
CREATE POLICY getdone_tenant_isolation ON integration_verification_evidence
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));

GRANT SELECT,INSERT,UPDATE ON integration_configurations TO getdone_tenant_runtime;
GRANT SELECT,INSERT ON integration_configuration_commands TO getdone_tenant_runtime;
GRANT SELECT,INSERT ON integration_verification_evidence TO getdone_tenant_runtime;

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-25.4')
ON CONFLICT(version) DO NOTHING;

COMMIT;
