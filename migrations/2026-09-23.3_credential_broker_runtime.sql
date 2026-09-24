BEGIN;

CREATE TABLE IF NOT EXISTS credential_leases (
  id text PRIMARY KEY,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  job_id text NOT NULL,
  resource_id text NOT NULL,
  provider_id text NOT NULL,
  capability text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','revoked','expired','released')),
  expires_at timestamptz NOT NULL,
  lease_hash text NOT NULL,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS credential_leases_scope_idx
  ON credential_leases(portfolio_id,company_id,status,expires_at);
CREATE INDEX IF NOT EXISTS credential_leases_job_idx
  ON credential_leases(job_id);

CREATE TABLE IF NOT EXISTS credential_usage_audits (
  id text PRIMARY KEY,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  lease_id text NOT NULL REFERENCES credential_leases(id),
  job_id text NOT NULL,
  provider_id text NOT NULL,
  capability text NOT NULL,
  used_at timestamptz NOT NULL,
  audit_hash text NOT NULL,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS credential_usage_audits_lease_idx
  ON credential_usage_audits(lease_id,used_at);

GRANT SELECT,INSERT,UPDATE,DELETE ON credential_leases,credential_usage_audits
  TO getdone_tenant_runtime;

ALTER TABLE credential_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_leases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON credential_leases;
CREATE POLICY getdone_tenant_isolation ON credential_leases
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));

ALTER TABLE credential_usage_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_usage_audits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON credential_usage_audits;
CREATE POLICY getdone_tenant_isolation ON credential_usage_audits
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-23.3')
ON CONFLICT (version) DO NOTHING;

COMMIT;
