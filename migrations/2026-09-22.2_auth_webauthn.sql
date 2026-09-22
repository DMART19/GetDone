BEGIN;

CREATE TABLE IF NOT EXISTS companies (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

INSERT INTO companies(id,organization_id,name)
SELECT DISTINCT p.company_id,p.organization_id,p.company_id
FROM portfolios p
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS company_memberships (
  user_id text NOT NULL REFERENCES auth_users(id),
  company_id text NOT NULL REFERENCES companies(id),
  role text NOT NULL CHECK (role IN ('owner','admin','operator','viewer')),
  status text NOT NULL CHECK (status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, company_id)
);
CREATE INDEX IF NOT EXISTS company_memberships_scope_idx
  ON company_memberships (company_id,status);

INSERT INTO company_memberships(user_id,company_id,role,status)
SELECT pm.user_id,pm.company_id,pm.role,pm.status
FROM portfolio_memberships pm
JOIN companies c ON c.id=pm.company_id
ON CONFLICT (user_id,company_id)
DO UPDATE SET role=EXCLUDED.role,status=EXCLUDED.status;

CREATE TABLE IF NOT EXISTS auth_webauthn_credentials (
  credential_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id),
  user_handle text,
  public_key_pem text NOT NULL,
  algorithm text NOT NULL CHECK (algorithm IN ('ES256','RS256')),
  sign_count bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS auth_webauthn_credentials_user_idx
  ON auth_webauthn_credentials (user_id,created_at)
  WHERE revoked_at IS NULL;

ALTER TABLE auth_step_up_challenges
  ADD COLUMN IF NOT EXISTS challenge_hash text,
  ADD COLUMN IF NOT EXISTS rp_id text,
  ADD COLUMN IF NOT EXISTS allowed_origins jsonb,
  ADD COLUMN IF NOT EXISTS require_user_verification boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS credential_ids jsonb;

UPDATE auth_step_up_challenges
SET consumed_at=COALESCE(consumed_at,now())
WHERE challenge_hash IS NULL
   OR rp_id IS NULL
   OR allowed_origins IS NULL
   OR credential_ids IS NULL;

CREATE TABLE IF NOT EXISTS auth_sign_in_challenges (
  challenge_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id),
  challenge_hash text NOT NULL,
  rp_id text NOT NULL,
  allowed_origins jsonb NOT NULL,
  require_user_verification boolean NOT NULL DEFAULT true,
  credential_ids jsonb NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > issued_at)
);
CREATE INDEX IF NOT EXISTS auth_sign_in_challenges_user_idx
  ON auth_sign_in_challenges (user_id,expires_at);

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-22.2')
ON CONFLICT (version) DO NOTHING;

COMMIT;
