BEGIN;

CREATE TABLE IF NOT EXISTS production_release_gate_evidence (
  id text PRIMARY KEY,
  candidate_sha text NOT NULL CHECK (candidate_sha ~ '^[a-f0-9]{40}$'),
  created_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('passed','failed')),
  gate_hash text NOT NULL CHECK (gate_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS production_release_gate_passed_sha_idx
  ON production_release_gate_evidence(candidate_sha)
  WHERE status='passed';

CREATE TABLE IF NOT EXISTS migration_compatibility_evidence (
  id text PRIMARY KEY,
  release_id text NOT NULL,
  previous_ref text NOT NULL,
  transition_migration text NOT NULL,
  verified_at timestamptz NOT NULL,
  old_on_new_hash text NOT NULL CHECK (old_on_new_hash ~ '^[a-f0-9]{64}$'),
  new_on_transition_hash text NOT NULL CHECK (new_on_transition_hash ~ '^[a-f0-9]{64}$'),
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS migration_compatibility_release_idx
  ON migration_compatibility_evidence(release_id,transition_migration);

GRANT SELECT ON production_release_gate_evidence TO getdone_tenant_runtime;
GRANT SELECT ON migration_compatibility_evidence TO getdone_tenant_runtime;
REVOKE INSERT,UPDATE,DELETE ON production_release_gate_evidence FROM getdone_tenant_runtime;
REVOKE INSERT,UPDATE,DELETE ON migration_compatibility_evidence FROM getdone_tenant_runtime;

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-25.2')
ON CONFLICT (version) DO NOTHING;

COMMIT;
