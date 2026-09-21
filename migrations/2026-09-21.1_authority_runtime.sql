BEGIN;

CREATE TABLE IF NOT EXISTS getdone_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS control_plane_entities (
  entity_type text NOT NULL,
  id text NOT NULL,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (entity_type, id)
);
CREATE INDEX IF NOT EXISTS control_plane_entities_scope_idx
  ON control_plane_entities (entity_type, portfolio_id, company_id);

CREATE TABLE IF NOT EXISTS idempotency_records (
  key text PRIMARY KEY,
  fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED','FAILED')),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  failed_at timestamptz,
  result jsonb,
  error_code text
);

CREATE TABLE IF NOT EXISTS audit_events (
  sequence bigserial PRIMARY KEY,
  id text NOT NULL UNIQUE,
  correlation_id text NOT NULL,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_correlation_idx
  ON audit_events (correlation_id, sequence);

CREATE TABLE IF NOT EXISTS authorization_grants (
  id text PRIMARY KEY,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  status text NOT NULL,
  expires_at timestamptz NOT NULL,
  grant_hash text NOT NULL,
  payload jsonb NOT NULL,
  revoked_reason text,
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS authorization_consumptions (
  id text PRIMARY KEY,
  grant_id text NOT NULL REFERENCES authorization_grants(id),
  consumer_type text NOT NULL,
  consumer_id text NOT NULL,
  consumption_hash text NOT NULL UNIQUE,
  consumed_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (grant_id)
);

CREATE TABLE IF NOT EXISTS verification_receipts (
  id text PRIMARY KEY,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  receipt_hash text NOT NULL,
  payload jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS job_execution_start_facts (
  id text PRIMARY KEY,
  job_id text NOT NULL,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  fact_hash text NOT NULL,
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS job_execution_completion_facts (
  id text PRIMARY KEY,
  job_id text NOT NULL,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  fact_hash text NOT NULL,
  payload jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS capacity_ledgers (
  id text PRIMARY KEY,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  revision integer NOT NULL,
  ledger_hash text NOT NULL,
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS capacity_reservations (
  id text PRIMARY KEY,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  idempotency_key text NOT NULL,
  reservation_hash text NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (portfolio_id, company_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS reservation_commits (
  transaction_id text PRIMARY KEY,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  idempotency_key text NOT NULL,
  commit_hash text NOT NULL,
  reservation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, company_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS job_runtime_state (
  job_id text PRIMARY KEY,
  envelope jsonb NOT NULL,
  envelope_hash text NOT NULL,
  runtime_state text NOT NULL CHECK (runtime_state IN ('queued','claimed','retry-wait','dead-lettered','cancelled','released')),
  version integer NOT NULL CHECK (version >= 1),
  state_hash text NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  scheduled_at timestamptz NOT NULL,
  cancelled_reason text,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS job_runtime_ready_idx
  ON job_runtime_state (runtime_state, scheduled_at);

CREATE TABLE IF NOT EXISTS job_runtime_transactions (
  id text PRIMARY KEY,
  job_id text NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  transaction_hash text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (job_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS job_leases (
  id text PRIMARY KEY,
  job_id text NOT NULL,
  worker_id text NOT NULL,
  state text NOT NULL,
  expires_at timestamptz NOT NULL,
  lease_hash text NOT NULL,
  version integer NOT NULL,
  payload jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS job_leases_one_active_per_job
  ON job_leases(job_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS job_leases_expiry_idx
  ON job_leases(state, expires_at);

CREATE TABLE IF NOT EXISTS job_retry_schedule (
  id text PRIMARY KEY,
  job_id text NOT NULL,
  run_at timestamptz NOT NULL,
  record_hash text NOT NULL,
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS job_dead_letters (
  id text PRIMARY KEY,
  job_id text NOT NULL UNIQUE,
  failed_at timestamptz NOT NULL,
  record_hash text NOT NULL,
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS job_recovery_records (
  id text PRIMARY KEY,
  job_id text NOT NULL,
  recovered_at timestamptz NOT NULL,
  record_hash text NOT NULL,
  payload jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS job_execution_specs (
  job_id text PRIMARY KEY,
  spec_hash text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS business_action_executions (
  request_id text PRIMARY KEY,
  job_id text NOT NULL,
  adapter_id text NOT NULL,
  provider_operation_id text,
  state text NOT NULL,
  request_hash text NOT NULL,
  record_hash text NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS software_pipeline_records (
  plan_id text PRIMARY KEY,
  state text NOT NULL,
  record_hash text NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-21.1')
ON CONFLICT (version) DO NOTHING;

COMMIT;
