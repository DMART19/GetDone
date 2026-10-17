BEGIN;

-- Issue #135: worker metadata is not business data. Keep it isolated under a
-- dedicated NOLOGIN role. The ordinary tenant role can neither inspect nor
-- forge another worker's heartbeats.
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['getdone_worker_registry','getdone_job_dispatch']::text[]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',role_name);
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname=role_name
        AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls)
    ) THEN RAISE EXCEPTION 'Unsafe worker service role: %',role_name; END IF;
    EXECUTE format('GRANT %I TO CURRENT_USER',role_name);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I',role_name);
  END LOOP;
END $$;

-- Only the registry role sees worker heartbeat tables. No DELETE or business
-- privilege; no unscoped policy on the tenant runtime role.
REVOKE ALL ON job_worker_instances,orchestration_worker_instances FROM getdone_tenant_runtime;
GRANT SELECT,INSERT,UPDATE ON job_worker_instances,orchestration_worker_instances TO getdone_worker_registry;
REVOKE DELETE ON job_worker_instances,orchestration_worker_instances FROM getdone_worker_registry;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['job_worker_instances','orchestration_worker_instances']::text[]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS getdone_worker_registry_only ON public.%I',table_name);
    EXECUTE format(
      'CREATE POLICY getdone_worker_registry_only ON public.%I FOR ALL TO getdone_worker_registry USING (true) WITH CHECK (true)',
      table_name
    );
  END LOOP;
END $$;

-- The tenant-authoritative job runtime state is identified by the signed
-- envelope scope, NOT by any client-provided job id alone.
ALTER TABLE job_runtime_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_runtime_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_job_tenant_only ON job_runtime_state;
CREATE POLICY getdone_job_tenant_only ON job_runtime_state
  FOR ALL TO getdone_tenant_runtime
  USING (
    getdone_tenant_scope_matches(
      envelope #>> '{scope,portfolioId}', envelope #>> '{scope,companyId}'
    ) AND job_id = envelope->>'jobId'
  )
  WITH CHECK (
    getdone_tenant_scope_matches(
      envelope #>> '{scope,portfolioId}', envelope #>> '{scope,companyId}'
    ) AND job_id = envelope->>'jobId'
  );

-- These records lack their own scope columns and inherit access from the
-- transactionally persisted job envelope. Do not grant global queue access.
DO $$
DECLARE table_name text;
  child_tables constant text[] := ARRAY[
    'job_leases','job_runtime_transactions','job_runtime_events',
    'job_execution_outcomes','job_retry_schedule','job_recovery_records',
    'job_dead_letters','job_execution_specs'
  ];
BEGIN
  FOREACH table_name IN ARRAY child_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS getdone_job_tenant_only ON public.%I',table_name);
    EXECUTE format(
      'CREATE POLICY getdone_job_tenant_only ON public.%I FOR ALL TO getdone_tenant_runtime ' ||
      'USING (EXISTS (SELECT 1 FROM public.job_runtime_state parent WHERE parent.job_id=%I.job_id)) ' ||
      'WITH CHECK (EXISTS (SELECT 1 FROM public.job_runtime_state parent WHERE parent.job_id=%I.job_id))',
      table_name,table_name,table_name
    );
  END LOOP;
END $$;

-- job_execution_specs is written just BEFORE enqueue creates job_runtime_state.
-- Its own parent is the already-authorized, tenant-scoped authoritative Job.
DROP POLICY IF EXISTS getdone_job_tenant_only ON job_execution_specs;
CREATE POLICY getdone_job_tenant_only ON job_execution_specs
  FOR ALL TO getdone_tenant_runtime
  USING (
    EXISTS (SELECT 1 FROM control_plane_entities job
      WHERE job.entity_type='job' AND job.id=job_execution_specs.job_id
        AND getdone_tenant_scope_matches(job.portfolio_id,job.company_id))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM control_plane_entities job
      WHERE job.entity_type='job' AND job.id=job_execution_specs.job_id
        AND getdone_tenant_scope_matches(job.portfolio_id,job.company_id))
  );

-- Reconciliation decisions have their own explicit scope.
ALTER TABLE job_disaster_recovery_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_disaster_recovery_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_job_tenant_only ON job_disaster_recovery_decisions;
CREATE POLICY getdone_job_tenant_only ON job_disaster_recovery_decisions
  FOR ALL TO getdone_tenant_runtime
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));

-- Preserve append-only integrity for worker transaction and evidence records.
GRANT SELECT,INSERT,UPDATE ON job_runtime_state,job_leases,job_retry_schedule
  TO getdone_tenant_runtime;
GRANT SELECT,INSERT ON job_runtime_transactions,job_runtime_events,
  job_execution_outcomes,job_recovery_records,job_dead_letters,
  job_execution_specs TO getdone_tenant_runtime;
REVOKE UPDATE,DELETE ON job_runtime_transactions,job_runtime_events,
  job_execution_outcomes,job_recovery_records,job_dead_letters,
  job_execution_specs FROM getdone_tenant_runtime;
REVOKE DELETE ON job_runtime_state,job_leases,job_retry_schedule
  FROM getdone_tenant_runtime;

-- Only server-side dedicated job workers may enumerate dispatch candidates.
-- These audited SECURITY DEFINER functions reveal bounded routing metadata,
-- NEVER a complete envelope, token, authorization grant or provider payload.
CREATE OR REPLACE FUNCTION public.getdone_discover_ready_jobs(
  requested_at timestamptz, requested_limit integer
)
RETURNS TABLE(job_id text, portfolio_id text, company_id text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
  SELECT s.job_id, s.envelope #>> '{scope,portfolioId}',
    s.envelope #>> '{scope,companyId}'
  FROM public.job_runtime_state s
  WHERE s.runtime_state IN ('queued','retry-wait')
    AND s.scheduled_at <= requested_at
    AND s.job_id = s.envelope->>'jobId'
    AND length(s.envelope #>> '{scope,portfolioId}') BETWEEN 1 AND 256
    AND length(s.envelope #>> '{scope,companyId}') BETWEEN 1 AND 256
    AND NOT EXISTS (
      SELECT 1 FROM public.job_disaster_recovery_decisions d
      WHERE d.job_id=s.job_id AND d.cleared_at IS NULL
        AND d.decision IN ('reconcile','blocked')
    )
  ORDER BY s.scheduled_at,s.job_id
  LIMIT LEAST(GREATEST(COALESCE(requested_limit,0),0),100)
$$;

CREATE OR REPLACE FUNCTION public.getdone_discover_expired_jobs(
  requested_at timestamptz, requested_limit integer
)
RETURNS TABLE(job_id text, portfolio_id text, company_id text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
  SELECT s.job_id, s.envelope #>> '{scope,portfolioId}',
    s.envelope #>> '{scope,companyId}'
  FROM public.job_runtime_state s
  JOIN public.job_leases l ON l.job_id=s.job_id
  WHERE l.state='active' AND l.expires_at <= requested_at
    AND s.job_id=s.envelope->>'jobId'
    AND length(s.envelope #>> '{scope,portfolioId}') BETWEEN 1 AND 256
    AND length(s.envelope #>> '{scope,companyId}') BETWEEN 1 AND 256
    AND NOT EXISTS (
      SELECT 1 FROM public.job_disaster_recovery_decisions d
      WHERE d.job_id=s.job_id AND d.cleared_at IS NULL
        AND d.decision IN ('reconcile','blocked')
    )
  ORDER BY l.expires_at,s.job_id
  LIMIT LEAST(GREATEST(COALESCE(requested_limit,0),0),100)
$$;

REVOKE ALL ON FUNCTION public.getdone_discover_ready_jobs(timestamptz,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.getdone_discover_expired_jobs(timestamptz,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.getdone_discover_ready_jobs(timestamptz,integer),
  public.getdone_discover_expired_jobs(timestamptz,integer) TO getdone_job_dispatch;

-- The discovery role must never directly SELECT job payloads or mutate data.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM getdone_job_dispatch;

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-10-17.2') ON CONFLICT(version) DO NOTHING;
COMMIT;
