BEGIN;

CREATE INDEX IF NOT EXISTS owner_intents_correlation_idx
  ON owner_intents ((payload->>'correlationId'));

CREATE INDEX IF NOT EXISTS control_plane_entities_correlation_idx
  ON control_plane_entities ((payload->>'correlationId'), entity_type);

CREATE INDEX IF NOT EXISTS job_runtime_state_correlation_idx
  ON job_runtime_state ((envelope->>'correlationId'));

CREATE INDEX IF NOT EXISTS business_action_executions_correlation_idx
  ON business_action_executions ((payload->>'correlationId'));

CREATE INDEX IF NOT EXISTS business_action_verification_correlation_idx
  ON business_action_verification_evidence ((payload->>'correlationId'));

CREATE INDEX IF NOT EXISTS job_execution_outcomes_correlation_idx
  ON job_execution_outcomes ((payload->>'correlationId'));

CREATE INDEX IF NOT EXISTS job_runtime_events_correlation_idx
  ON job_runtime_events ((payload->>'correlationId'));

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-24.1')
ON CONFLICT (version) DO NOTHING;

COMMIT;
