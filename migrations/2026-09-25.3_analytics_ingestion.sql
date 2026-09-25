BEGIN;

CREATE TABLE IF NOT EXISTS analytics_ingestion_checkpoints (
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development','staging','production')),
  source_id text NOT NULL,
  cursor_value text,
  version integer NOT NULL CHECK (version >= 1),
  checkpoint_hash text NOT NULL CHECK (checkpoint_hash ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (portfolio_id,company_id,environment,source_id)
);

CREATE TABLE IF NOT EXISTS analytics_ingestion_evidence (
  evidence_hash text PRIMARY KEY CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development','staging','production')),
  source_id text NOT NULL,
  external_id text NOT NULL,
  dedupe_key text NOT NULL CHECK (dedupe_key ~ '^[a-f0-9]{64}$'),
  source_updated_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  fresh boolean NOT NULL,
  provenance_hash text NOT NULL CHECK (provenance_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  provenance jsonb NOT NULL,
  UNIQUE (portfolio_id,company_id,environment,source_id,dedupe_key)
);

CREATE TABLE IF NOT EXISTS analytics_ingestion_runs (
  request_id text PRIMARY KEY,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development','staging','production')),
  source_id text NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  result_hash text NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS analytics_ingestion_evidence_source_idx
  ON analytics_ingestion_evidence(
    portfolio_id,company_id,environment,source_id,source_updated_at DESC
  );

CREATE INDEX IF NOT EXISTS analytics_ingestion_checkpoint_updated_idx
  ON analytics_ingestion_checkpoints(updated_at DESC);

CREATE INDEX IF NOT EXISTS analytics_ingestion_runs_scope_idx
  ON analytics_ingestion_runs(portfolio_id,company_id,environment,source_id,observed_at DESC);

ALTER TABLE analytics_ingestion_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_ingestion_checkpoints FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON analytics_ingestion_checkpoints;
CREATE POLICY getdone_tenant_isolation ON analytics_ingestion_checkpoints
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));

ALTER TABLE analytics_ingestion_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_ingestion_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON analytics_ingestion_evidence;
CREATE POLICY getdone_tenant_isolation ON analytics_ingestion_evidence
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));

ALTER TABLE analytics_ingestion_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_ingestion_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON analytics_ingestion_runs;
CREATE POLICY getdone_tenant_isolation ON analytics_ingestion_runs
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));

GRANT SELECT,INSERT,UPDATE ON analytics_ingestion_checkpoints TO getdone_tenant_runtime;
GRANT SELECT,INSERT ON analytics_ingestion_evidence TO getdone_tenant_runtime;
GRANT SELECT,INSERT ON analytics_ingestion_runs TO getdone_tenant_runtime;

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-25.3')
ON CONFLICT(version) DO NOTHING;

COMMIT;
