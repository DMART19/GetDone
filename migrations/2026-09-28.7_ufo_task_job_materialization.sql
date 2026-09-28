BEGIN;

CREATE TABLE IF NOT EXISTS orchestration_generated_tasks (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES orchestration_runs(id),
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  logical_key text NOT NULL,
  plan_id text NOT NULL,
  plan_step_id text NOT NULL,
  task_hash text NOT NULL CHECK (task_hash ~ '^[a-f0-9]{64}$'),
  authorization_grant_id text NOT NULL REFERENCES authorization_grants(id),
  authorization_consumption_hash text NOT NULL
    CHECK (authorization_consumption_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (run_id, logical_key),
  UNIQUE (run_id, plan_step_id)
);

CREATE INDEX IF NOT EXISTS orchestration_generated_tasks_scope_idx
  ON orchestration_generated_tasks
  (portfolio_id, company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS orchestration_generated_tasks_run_idx
  ON orchestration_generated_tasks
  (run_id, plan_step_id);

GRANT SELECT,INSERT ON orchestration_generated_tasks
  TO getdone_tenant_runtime;

ALTER TABLE orchestration_generated_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_generated_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation
  ON orchestration_generated_tasks;
CREATE POLICY getdone_tenant_isolation
  ON orchestration_generated_tasks
  USING (getdone_tenant_scope_matches(portfolio_id, company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id, company_id));

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-28.7')
ON CONFLICT (version) DO NOTHING;

COMMIT;
