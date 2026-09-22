BEGIN;

CREATE TABLE IF NOT EXISTS compute_nodes (
  id text PRIMARY KEY,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  owner_user_id text NOT NULL,
  resource_enrollment_id text NOT NULL UNIQUE,
  resource_id text,
  display_name text NOT NULL,
  platform text NOT NULL CHECK (platform = 'linux'),
  architecture text NOT NULL CHECK (architecture IN ('x86_64','arm64')),
  agent_version text NOT NULL,
  protocol_version text NOT NULL,
  lifecycle_state text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS compute_nodes_scope_idx
  ON compute_nodes(portfolio_id, company_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS node_enrollment_challenges (
  id text PRIMARY KEY,
  resource_enrollment_id text NOT NULL UNIQUE,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  owner_user_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development','staging','production')),
  display_name text NOT NULL,
  platform text NOT NULL CHECK (platform = 'linux'),
  architecture text NOT NULL CHECK (architecture IN ('x86_64','arm64')),
  protocol_version text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('pending','consumed','expired','cancelled')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_nonce_hash text,
  node_id text REFERENCES compute_nodes(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  payload jsonb NOT NULL,
  CHECK (expires_at > issued_at),
  CHECK (
    (state = 'consumed' AND consumed_at IS NOT NULL AND consumed_nonce_hash IS NOT NULL AND node_id IS NOT NULL)
    OR state <> 'consumed'
  )
);

CREATE INDEX IF NOT EXISTS node_enrollment_challenges_scope_idx
  ON node_enrollment_challenges(portfolio_id, company_id, issued_at DESC);

CREATE TABLE IF NOT EXISTS node_identity_credentials (
  id text PRIMARY KEY,
  node_id text NOT NULL REFERENCES compute_nodes(id),
  serial_number text NOT NULL UNIQUE,
  public_key_fingerprint text NOT NULL,
  certificate_pem text NOT NULL,
  certificate_chain_pem text NOT NULL,
  credential_hash text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  payload jsonb NOT NULL,
  CHECK (expires_at > issued_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS node_identity_one_active_credential
  ON node_identity_credentials(node_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS node_certificate_rotations (
  id text PRIMARY KEY,
  node_id text NOT NULL REFERENCES compute_nodes(id),
  previous_credential_id text NOT NULL REFERENCES node_identity_credentials(id),
  next_credential_id text NOT NULL REFERENCES node_identity_credentials(id),
  requested_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  rotation_hash text NOT NULL UNIQUE,
  payload jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS node_agent_sessions (
  id text PRIMARY KEY,
  node_id text NOT NULL REFERENCES compute_nodes(id),
  credential_id text NOT NULL REFERENCES node_identity_credentials(id),
  session_hash text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  payload jsonb NOT NULL,
  CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS node_agent_sessions_active_idx
  ON node_agent_sessions(node_id, expires_at DESC)
  WHERE revoked_at IS NULL;

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-21.2')
ON CONFLICT (version) DO NOTHING;

COMMIT;
