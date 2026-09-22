BEGIN;

CREATE TABLE IF NOT EXISTS job_worker_instances (
  worker_id text PRIMARY KEY,
  process_role text NOT NULL CHECK (process_role = 'job-worker'),
  started_at timestamptz NOT NULL,
  last_poll_at timestamptz,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error_hash text,
  status text NOT NULL CHECK (status IN ('starting','running','degraded','stopped')),
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS job_worker_instances_status_idx
  ON job_worker_instances (status,updated_at DESC);

CREATE TABLE IF NOT EXISTS business_action_verification_evidence (
  evidence_id text PRIMARY KEY,
  job_id text NOT NULL,
  request_id text NOT NULL,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  evidence_hash text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  observed_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS business_action_verification_scope_idx
  ON business_action_verification_evidence
  (portfolio_id,company_id,job_id,observed_at DESC);

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-22.3')
ON CONFLICT (version) DO NOTHING;

COMMIT;
