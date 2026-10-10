BEGIN;

-- Authentication bootstrap state, like auth_sign_in_challenges, is resolved by
-- an unguessable token before tenant scope exists. No browser selects an owner.
CREATE TABLE IF NOT EXISTS auth_owner_enrollments (
  user_id text PRIMARY KEY REFERENCES auth_users(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  environment text NOT NULL CHECK (environment IN ('staging','production')),
  rp_id text NOT NULL,
  allowed_origins jsonb NOT NULL,
  user_handle text NOT NULL,
  expires_at timestamptz NOT NULL,
  challenge_hash text,
  challenge_expires_at timestamptz,
  consumed_at timestamptz,
  credential_id text,
  CHECK ((consumed_at IS NULL) = (credential_id IS NULL))
);
REVOKE ALL ON auth_owner_enrollments FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON auth_owner_enrollments TO getdone_tenant_runtime;

INSERT INTO getdone_schema_migrations(version) VALUES ('2026-10-10.1')
ON CONFLICT(version) DO NOTHING;
COMMIT;
