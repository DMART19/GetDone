BEGIN;

CREATE TABLE IF NOT EXISTS disaster_recovery_incidents (
  id text PRIMARY KEY,
  declared_at timestamptz NOT NULL,
  lost_primary_at timestamptz NOT NULL,
  source_backup_sha256 text NOT NULL CHECK (source_backup_sha256 ~ '^[a-f0-9]{64}$'),
  source_snapshot_hash text NOT NULL CHECK (source_snapshot_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('active','closed')),
  incident_hash text NOT NULL CHECK (incident_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS job_disaster_recovery_decisions (
  incident_id text NOT NULL REFERENCES disaster_recovery_incidents(id) ON DELETE RESTRICT,
  job_id text NOT NULL,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('resume','reconcile','blocked')),
  reason_code text NOT NULL,
  runtime_state text NOT NULL,
  runtime_hash text NOT NULL CHECK (runtime_hash ~ '^[a-f0-9]{64}$'),
  spec_hash text,
  provider_record_hash text,
  decided_at timestamptz NOT NULL,
  decision_hash text NOT NULL CHECK (decision_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  cleared_at timestamptz,
  clearance_evidence_hash text,
  PRIMARY KEY(incident_id,job_id),
  CHECK (spec_hash IS NULL OR spec_hash ~ '^[a-f0-9]{64}$'),
  CHECK (provider_record_hash IS NULL OR provider_record_hash ~ '^[a-f0-9]{64}$'),
  CHECK (clearance_evidence_hash IS NULL OR clearance_evidence_hash ~ '^[a-f0-9]{64}$'),
  CHECK (
    (cleared_at IS NULL AND clearance_evidence_hash IS NULL)
    OR (cleared_at IS NOT NULL AND clearance_evidence_hash IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS job_disaster_recovery_active_hold_idx
  ON job_disaster_recovery_decisions(job_id)
  WHERE cleared_at IS NULL AND decision IN ('reconcile','blocked');

CREATE INDEX IF NOT EXISTS job_disaster_recovery_incident_decision_idx
  ON job_disaster_recovery_decisions(incident_id,decision,job_id);

GRANT SELECT ON disaster_recovery_incidents TO getdone_tenant_runtime;
GRANT SELECT ON job_disaster_recovery_decisions TO getdone_tenant_runtime;
REVOKE INSERT,UPDATE,DELETE ON disaster_recovery_incidents FROM getdone_tenant_runtime;
REVOKE INSERT,UPDATE,DELETE ON job_disaster_recovery_decisions FROM getdone_tenant_runtime;

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-25.1')
ON CONFLICT (version) DO NOTHING;

COMMIT;
