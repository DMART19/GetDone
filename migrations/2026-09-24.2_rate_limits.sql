BEGIN;

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  policy_id text NOT NULL,
  bucket_key_hash text NOT NULL CHECK (bucket_key_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz NOT NULL,
  window_expires_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(policy_id,bucket_key_hash),
  CHECK (window_expires_at > window_started_at)
);

CREATE INDEX IF NOT EXISTS rate_limit_buckets_expiry_idx
  ON rate_limit_buckets(window_expires_at);

GRANT SELECT,INSERT,UPDATE,DELETE ON rate_limit_buckets
  TO getdone_tenant_runtime;

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-24.2')
ON CONFLICT (version) DO NOTHING;

COMMIT;
