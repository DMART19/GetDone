BEGIN;

ALTER TABLE orchestration_runs
  DROP CONSTRAINT IF EXISTS orchestration_runs_state_check;

ALTER TABLE orchestration_runs
  ADD CONSTRAINT orchestration_runs_state_check
  CHECK (state IN (
    'received','context-building','planning','validating','policy-evaluation',
    'awaiting-approval','policy-cleared','authorized','materializing','queued',
    'executing','verifying','succeeded','blocked','failed','cancelled',
    'replan-required'
  )) NOT VALID;

ALTER TABLE orchestration_runs
  VALIDATE CONSTRAINT orchestration_runs_state_check;

CREATE TABLE IF NOT EXISTS orchestration_planning_artifacts (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES orchestration_runs(id),
  correlation_id text NOT NULL,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  artifact_kind text NOT NULL CHECK (artifact_kind IN (
    'context-snapshot',
    'plan-proposal',
    'validation-attestation',
    'policy-bundle'
  )),
  artifact_hash text NOT NULL,
  predecessor_hash text,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (run_id,artifact_kind,artifact_hash)
);

CREATE INDEX IF NOT EXISTS orchestration_planning_artifacts_run_kind_idx
  ON orchestration_planning_artifacts(run_id,artifact_kind,created_at DESC,id DESC);

CREATE INDEX IF NOT EXISTS orchestration_planning_artifacts_scope_idx
  ON orchestration_planning_artifacts(portfolio_id,company_id,created_at DESC);

CREATE INDEX IF NOT EXISTS orchestration_planning_artifacts_correlation_idx
  ON orchestration_planning_artifacts(correlation_id,created_at,id);

ALTER TABLE orchestration_planning_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_planning_artifacts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_planning_artifacts;
CREATE POLICY getdone_tenant_isolation ON orchestration_planning_artifacts
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));

GRANT SELECT,INSERT ON orchestration_planning_artifacts TO getdone_tenant_runtime;
REVOKE UPDATE,DELETE ON orchestration_planning_artifacts FROM getdone_tenant_runtime;

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-27.2')
ON CONFLICT(version) DO NOTHING;

COMMIT;
