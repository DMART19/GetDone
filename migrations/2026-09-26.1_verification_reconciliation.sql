BEGIN;

ALTER TABLE job_runtime_state
  DROP CONSTRAINT IF EXISTS job_runtime_state_runtime_state_check;

ALTER TABLE job_runtime_state
  ADD CONSTRAINT job_runtime_state_runtime_state_check
  CHECK (runtime_state IN (
    'queued',
    'claimed',
    'retry-wait',
    'dead-lettered',
    'cancelled',
    'released',
    'uncertain'
  ));

CREATE INDEX IF NOT EXISTS job_runtime_uncertain_idx
  ON job_runtime_state (updated_at DESC)
  WHERE runtime_state = 'uncertain';

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-26.1')
ON CONFLICT (version) DO NOTHING;

COMMIT;
