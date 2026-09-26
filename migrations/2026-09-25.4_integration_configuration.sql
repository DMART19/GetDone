BEGIN;

CREATE TABLE IF NOT EXISTS integration_configurations (
  id text PRIMARY KEY,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development','staging','production')),
  provider text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','active','disabled','revoked')),
  health text NOT NULL CHECK (health IN ('unknown','healthy','degraded','unavailable')),
  credential_binding_id text,
  version integer NOT NULL CHECK (version >= 1),
  configuration_hash text NOT NULL CHECK (configuration_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (portfolio_id,company_id,environment,provider,display_name)
);

CREATE TABLE IF NOT EXISTS integration_verification_evidence (
  id text PRIMARY KEY,
  integration_id text NOT NULL REFERENCES integration_configurations(id) ON DELETE RESTRICT,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development','staging','production')),
  health text NOT NULL CHECK (health IN ('unknown','healthy','degraded','unavailable')),
  verified_at timestamptz NOT NULL,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  UNIQUE (integration_id,evidence_hash)
);

CREATE TABLE IF NOT EXISTS integration_configuration_idempotency (
  idempotency_key_hash text PRIMARY KEY CHECK (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  integration_id text NOT NULL REFERENCES integration_configurations(id) ON DELETE RESTRICT,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS integration_configurations_scope_status_idx
  ON integration_configurations(portfolio_id,company_id,environment,status,updated_at DESC);

CREATE INDEX IF NOT EXISTS integration_verification_latest_idx
  ON integration_verification_evidence(integration_id,verified_at DESC);

ALTER TABLE integration_configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_configurations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON integration_configurations;
CREATE POLICY getdone_tenant_isolation ON integration_configurations
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));

ALTER TABLE integration_verification_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_verification_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON integration_verification_evidence;
CREATE POLICY getdone_tenant_isolation ON integration_verification_evidence
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));

ALTER TABLE integration_configuration_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_configuration_idempotency FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON integration_configuration_idempotency;
CREATE POLICY getdone_tenant_isolation ON integration_configuration_idempotency
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));

GRANT SELECT,INSERT,UPDATE ON integration_configurations TO getdone_tenant_runtime;
GRANT SELECT,INSERT ON integration_verification_evidence TO getdone_tenant_runtime;
GRANT SELECT,INSERT ON integration_configuration_idempotency TO getdone_tenant_runtime;
REVOKE DELETE ON integration_configurations FROM getdone_tenant_runtime;
REVOKE UPDATE,DELETE ON integration_verification_evidence FROM getdone_tenant_runtime;
REVOKE UPDATE,DELETE ON integration_configuration_idempotency FROM getdone_tenant_runtime;

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-25.4')
ON CONFLICT(version) DO NOTHING;

COMMIT;
