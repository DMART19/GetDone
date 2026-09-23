BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'getdone_tenant_runtime'
  ) THEN
    CREATE ROLE getdone_tenant_runtime
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOBYPASSRLS;
  END IF;
END
$$;

GRANT getdone_tenant_runtime TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO getdone_tenant_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO getdone_tenant_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO getdone_tenant_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO getdone_tenant_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO getdone_tenant_runtime;

CREATE OR REPLACE FUNCTION getdone_tenant_scope_matches(
  row_portfolio_id text,
  row_company_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT
    NULLIF(current_setting('getdone.portfolio_id', true), '') IS NOT NULL
    AND NULLIF(current_setting('getdone.company_id', true), '') IS NOT NULL
    AND row_portfolio_id = current_setting('getdone.portfolio_id', true)
    AND row_company_id = current_setting('getdone.company_id', true)
$$;

REVOKE ALL ON FUNCTION getdone_tenant_scope_matches(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION getdone_tenant_scope_matches(text, text)
  TO getdone_tenant_runtime;

DO $$
DECLARE
  table_name text;
  tenant_tables constant text[] := ARRAY[
    'control_plane_entities',
    'audit_events',
    'authorization_grants',
    'verification_receipts',
    'job_execution_start_facts',
    'job_execution_completion_facts',
    'capacity_ledgers',
    'capacity_reservations',
    'reservation_commits',
    'owner_intents',
    'resource_evidence',
    'business_action_verification_evidence'
  ];
BEGIN
  FOREACH table_name IN ARRAY tenant_tables
  LOOP
    IF to_regclass(table_name) IS NULL THEN
      RAISE EXCEPTION 'Required tenant-scoped production relation is missing: %', table_name;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'DROP POLICY IF EXISTS getdone_tenant_isolation ON %I',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY getdone_tenant_isolation ON %I
         USING (getdone_tenant_scope_matches(portfolio_id, company_id))
         WITH CHECK (getdone_tenant_scope_matches(portfolio_id, company_id))',
      table_name
    );
  END LOOP;
END
$$;

ALTER TABLE authorization_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE authorization_consumptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON authorization_consumptions;
CREATE POLICY getdone_tenant_isolation ON authorization_consumptions
  USING (
    EXISTS (
      SELECT 1
      FROM authorization_grants grant_record
      WHERE grant_record.id = authorization_consumptions.grant_id
        AND getdone_tenant_scope_matches(
          grant_record.portfolio_id,
          grant_record.company_id
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM authorization_grants grant_record
      WHERE grant_record.id = authorization_consumptions.grant_id
        AND getdone_tenant_scope_matches(
          grant_record.portfolio_id,
          grant_record.company_id
        )
    )
  );

CREATE INDEX IF NOT EXISTS business_action_executions_job_idx
  ON business_action_executions(job_id);

ALTER TABLE business_action_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_action_executions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON business_action_executions;
CREATE POLICY getdone_tenant_isolation ON business_action_executions
  USING (
    EXISTS (
      SELECT 1
      FROM control_plane_entities authoritative_job
      WHERE authoritative_job.entity_type = 'job'
        AND authoritative_job.id = business_action_executions.job_id
        AND getdone_tenant_scope_matches(
          authoritative_job.portfolio_id,
          authoritative_job.company_id
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM control_plane_entities authoritative_job
      WHERE authoritative_job.entity_type = 'job'
        AND authoritative_job.id = business_action_executions.job_id
        AND getdone_tenant_scope_matches(
          authoritative_job.portfolio_id,
          authoritative_job.company_id
        )
    )
  );

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-23.1')
ON CONFLICT (version) DO NOTHING;

COMMIT;
