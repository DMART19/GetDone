BEGIN;

CREATE TABLE IF NOT EXISTS orchestration_execution_artifacts (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES orchestration_runs(id),
  correlation_id text NOT NULL,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  artifact_kind text NOT NULL CHECK (artifact_kind IN (
    'validation-receipt',
    'authorization-bundle',
    'task-dag',
    'job-batch'
  )),
  artifact_hash text NOT NULL,
  predecessor_hash text,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (run_id,artifact_kind,artifact_hash)
);

CREATE INDEX IF NOT EXISTS orchestration_execution_artifacts_run_kind_idx
  ON orchestration_execution_artifacts(run_id,artifact_kind,created_at DESC,id DESC);

CREATE INDEX IF NOT EXISTS orchestration_execution_artifacts_scope_idx
  ON orchestration_execution_artifacts(portfolio_id,company_id,created_at DESC);

CREATE INDEX IF NOT EXISTS orchestration_execution_artifacts_correlation_idx
  ON orchestration_execution_artifacts(correlation_id,created_at,id);

ALTER TABLE orchestration_execution_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_execution_artifacts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_execution_artifacts;
CREATE POLICY getdone_tenant_isolation ON orchestration_execution_artifacts
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));

GRANT SELECT,INSERT ON orchestration_execution_artifacts TO getdone_tenant_runtime;
REVOKE UPDATE,DELETE ON orchestration_execution_artifacts FROM getdone_tenant_runtime;

CREATE TABLE IF NOT EXISTS orchestration_task_generation_claims (
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  logical_key text NOT NULL,
  task_id text NOT NULL UNIQUE,
  task_hash text NOT NULL,
  grant_id text NOT NULL REFERENCES authorization_grants(id),
  consumption_hash text NOT NULL UNIQUE,
  task_payload jsonb NOT NULL,
  consumption_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (portfolio_id,company_id,logical_key)
);

CREATE INDEX IF NOT EXISTS orchestration_task_generation_claims_grant_idx
  ON orchestration_task_generation_claims(grant_id);

CREATE INDEX IF NOT EXISTS orchestration_task_generation_claims_created_idx
  ON orchestration_task_generation_claims(portfolio_id,company_id,created_at DESC);

ALTER TABLE orchestration_task_generation_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_task_generation_claims FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_task_generation_claims;
CREATE POLICY getdone_tenant_isolation ON orchestration_task_generation_claims
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));

GRANT SELECT,INSERT ON orchestration_task_generation_claims TO getdone_tenant_runtime;
REVOKE UPDATE,DELETE ON orchestration_task_generation_claims FROM getdone_tenant_runtime;

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-27.3')
ON CONFLICT(version) DO NOTHING;

COMMIT;
