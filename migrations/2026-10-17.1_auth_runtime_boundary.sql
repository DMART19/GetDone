BEGIN;

-- Issue #133: pre-authentication lookups cannot use getdone_tenant_runtime,
-- whose row-level-security policies deliberately reject all unscoped reads.
-- Give authentication its own NOLOGIN/NOBYPASSRLS role. The web process must
-- SET ROLE explicitly for ONLY the auth/scope adapters. Ordinary business and
-- action stores must continue to SET ROLE getdone_tenant_runtime.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'getdone_auth_runtime') THEN
    CREATE ROLE getdone_auth_runtime
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'getdone_auth_runtime'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'getdone_auth_runtime must remain restricted, NOLOGIN and NOBYPASSRLS';
  END IF;
END $$;

GRANT getdone_auth_runtime TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO getdone_auth_runtime;

-- The auth/security connection can inspect identities, memberships,
-- challenges, sessions and hashed rate-limit buckets. It cannot access
-- business data, jobs or execution authority.
GRANT SELECT ON
  auth_users, auth_sessions, auth_webauthn_credentials,
  auth_owner_enrollments, auth_sign_in_challenges, auth_step_up_challenges,
  organizations, companies, portfolios,
  organization_memberships, company_memberships, portfolio_memberships,
  rate_limit_buckets
TO getdone_auth_runtime;

-- Only the insert/update operations that passkey sign-in, sign-out,
-- step-up and invitation consumption actually need.
GRANT INSERT ON
  auth_sessions, auth_sign_in_challenges, auth_step_up_challenges,
  auth_webauthn_credentials, rate_limit_buckets
TO getdone_auth_runtime;

GRANT UPDATE (request_count, window_started_at, window_expires_at, updated_at)
  ON rate_limit_buckets TO getdone_auth_runtime;
GRANT UPDATE (revoked_at, token_hash, step_up_authenticated_at)
  ON auth_sessions TO getdone_auth_runtime;
GRANT UPDATE (sign_count, last_used_at)
  ON auth_webauthn_credentials TO getdone_auth_runtime;
GRANT UPDATE (consumed_at)
  ON auth_sign_in_challenges TO getdone_auth_runtime;
GRANT UPDATE (consumed_at)
  ON auth_step_up_challenges TO getdone_auth_runtime;
GRANT UPDATE (challenge_hash, challenge_expires_at, consumed_at, credential_id)
  ON auth_owner_enrollments TO getdone_auth_runtime;

-- A dedicated trusted server-side auth role needs to look up an owner before
-- a tenant exists. The scope resolver still checks all three active
-- membership joins and all application queries are parameter-bound.
-- These table-specific policies apply ONLY TO getdone_auth_runtime. They
-- never grant unscoped access to getdone_tenant_runtime, anon or authenticated.
DO $$
DECLARE
  table_name text;
  auth_tables constant text[] := ARRAY[
    'auth_users', 'auth_sessions', 'auth_webauthn_credentials',
    'auth_owner_enrollments', 'auth_sign_in_challenges',
    'auth_step_up_challenges', 'organizations', 'companies', 'portfolios',
    'organization_memberships', 'company_memberships',
    'portfolio_memberships', 'rate_limit_buckets'
  ];
BEGIN
  FOREACH table_name IN ARRAY auth_tables LOOP
    IF to_regclass(format('public.%I', table_name)) IS NULL THEN
      RAISE EXCEPTION 'Required auth-boundary table is missing: %', table_name;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS getdone_server_auth_only ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY getdone_server_auth_only ON public.%I ' ||
      'FOR ALL TO getdone_auth_runtime USING (true) WITH CHECK (true)',
      table_name
    );
  END LOOP;
END $$;

-- Refuse any migration drift that accidentally gives auth role business
-- execution access, even if the role already existed prior to this migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE grantee = 'getdone_auth_runtime'
      AND table_schema = 'public'
      AND table_name NOT IN (
        'auth_users','auth_sessions','auth_webauthn_credentials',
        'auth_owner_enrollments','auth_sign_in_challenges',
        'auth_step_up_challenges','organizations','companies','portfolios',
        'organization_memberships','company_memberships',
        'portfolio_memberships','rate_limit_buckets'
      )
  ) THEN
    RAISE EXCEPTION 'getdone_auth_runtime has unexpected business table grants';
  END IF;
END $$;

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-10-17.1')
ON CONFLICT(version) DO NOTHING;

COMMIT;
