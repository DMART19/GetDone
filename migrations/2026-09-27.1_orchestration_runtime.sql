BEGIN;

CREATE TABLE IF NOT EXISTS orchestration_runs (
  id text PRIMARY KEY,
  correlation_id text NOT NULL,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development','staging','production')),
  authority_user_id text NOT NULL,
  initiating_actor_type text NOT NULL CHECK (initiating_actor_type IN ('user','system','worker')),
  initiating_actor_id text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('owner-intent','investigation','objective')),
  source_id text NOT NULL,
  source_payload jsonb NOT NULL,
  state text NOT NULL CHECK (state IN (
    'received','context-building','planning','validating','policy-evaluation',
    'awaiting-approval','authorized','materializing','queued','executing',
    'verifying','succeeded','blocked','failed','cancelled','replan-required'
  )),
  attempt integer NOT NULL CHECK (attempt >= 1),
  version integer NOT NULL CHECK (version >= 1),
  available_at timestamptz NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (portfolio_id,company_id,source_kind,source_id),
  CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS orchestration_runs_scope_state_idx
  ON orchestration_runs(portfolio_id,company_id,state,available_at,updated_at);

CREATE INDEX IF NOT EXISTS orchestration_runs_correlation_idx
  ON orchestration_runs(correlation_id,updated_at);

CREATE TABLE IF NOT EXISTS orchestration_outbox (
  id text PRIMARY KEY,
  correlation_id text NOT NULL,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('orchestration.triggered','orchestration.resume')),
  run_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  claimed_by text,
  claimed_until timestamptz,
  delivered_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  CHECK (
    (claimed_by IS NULL AND claimed_until IS NULL)
    OR (claimed_by IS NOT NULL AND claimed_until IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS orchestration_outbox_ready_idx
  ON orchestration_outbox(available_at,occurred_at,id)
  WHERE delivered_at IS NULL;

ALTER TABLE orchestration_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_runs;
CREATE POLICY getdone_tenant_isolation ON orchestration_runs
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));

GRANT SELECT,INSERT,UPDATE ON orchestration_runs TO getdone_tenant_runtime;
REVOKE DELETE ON orchestration_runs FROM getdone_tenant_runtime;

-- The outbox is an internal cross-tenant routing queue and intentionally contains
-- only routing metadata, never owner messages, plan content, credentials, or provider payloads.
GRANT SELECT,INSERT,UPDATE ON orchestration_outbox TO getdone_tenant_runtime;
REVOKE DELETE ON orchestration_outbox FROM getdone_tenant_runtime;

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-27.1')
ON CONFLICT(version) DO NOTHING;

COMMIT;
