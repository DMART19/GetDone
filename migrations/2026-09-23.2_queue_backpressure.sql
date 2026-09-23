BEGIN;

CREATE TABLE IF NOT EXISTS provider_concurrency_leases (
  id text PRIMARY KEY,
  provider_key text NOT NULL,
  request_id text NOT NULL,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('execute','status','cancel')),
  acquired_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS provider_concurrency_leases_active_idx
  ON provider_concurrency_leases (provider_key, expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON provider_concurrency_leases
  TO getdone_tenant_runtime;

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-23.2')
ON CONFLICT (version) DO NOTHING;

COMMIT;
