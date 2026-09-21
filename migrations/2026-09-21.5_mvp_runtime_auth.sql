BEGIN;

CREATE TABLE IF NOT EXISTS auth_users (
  id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portfolios (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  company_id text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, company_id)
);

CREATE TABLE IF NOT EXISTS organization_memberships (
  user_id text NOT NULL REFERENCES auth_users(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  role text NOT NULL CHECK (role IN ('owner','admin','operator','viewer')),
  status text NOT NULL CHECK (status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, organization_id)
);

CREATE TABLE IF NOT EXISTS portfolio_memberships (
  user_id text NOT NULL REFERENCES auth_users(id),
  portfolio_id text NOT NULL REFERENCES portfolios(id),
  company_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','admin','operator','viewer')),
  status text NOT NULL CHECK (status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, portfolio_id)
);
CREATE INDEX IF NOT EXISTS portfolio_memberships_scope_idx
  ON portfolio_memberships (portfolio_id, company_id, status);

CREATE TABLE IF NOT EXISTS auth_sessions (
  session_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id),
  token_hash text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  authenticated_at timestamptz NOT NULL,
  step_up_authenticated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > issued_at)
);
CREATE INDEX IF NOT EXISTS auth_sessions_active_idx
  ON auth_sessions (token_hash, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_step_up_credentials (
  user_id text PRIMARY KEY REFERENCES auth_users(id),
  secret_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz
);

CREATE TABLE IF NOT EXISTS auth_step_up_challenges (
  challenge_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES auth_sessions(session_id),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > issued_at)
);
CREATE INDEX IF NOT EXISTS auth_step_up_challenges_session_idx
  ON auth_step_up_challenges (session_id, expires_at);

CREATE TABLE IF NOT EXISTS owner_intents (
  id text PRIMARY KEY,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth_users(id),
  idempotency_key text NOT NULL,
  received_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (portfolio_id, company_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS resource_evidence (
  evidence_kind text NOT NULL,
  id text NOT NULL,
  resource_id text NOT NULL,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (evidence_kind, id)
);
CREATE INDEX IF NOT EXISTS resource_evidence_resource_idx
  ON resource_evidence (resource_id, evidence_kind, observed_at DESC);

CREATE TABLE IF NOT EXISTS job_execution_outcomes (
  id text PRIMARY KEY,
  job_id text NOT NULL,
  kind text NOT NULL,
  runtime_state text NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 0),
  occurred_at timestamptz NOT NULL,
  transaction_hash text NOT NULL,
  record_hash text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  UNIQUE (job_id, transaction_hash)
);
CREATE INDEX IF NOT EXISTS job_execution_outcomes_job_idx
  ON job_execution_outcomes (job_id, occurred_at, id);

CREATE TABLE IF NOT EXISTS job_runtime_events (
  id text PRIMARY KEY,
  job_id text NOT NULL,
  event_type text NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 0),
  occurred_at timestamptz NOT NULL,
  transaction_hash text NOT NULL,
  outcome_hash text NOT NULL,
  record_hash text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  UNIQUE (job_id, transaction_hash, event_type)
);
CREATE INDEX IF NOT EXISTS job_runtime_events_job_idx
  ON job_runtime_events (job_id, occurred_at, id);

CREATE TABLE IF NOT EXISTS database_backup_evidence (
  id text PRIMARY KEY,
  completed_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('verified','failed')),
  backup_ref_hash text NOT NULL,
  verification_hash text NOT NULL,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS database_backup_evidence_completed_idx
  ON database_backup_evidence (completed_at DESC);

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-21.5')
ON CONFLICT (version) DO NOTHING;

COMMIT;
