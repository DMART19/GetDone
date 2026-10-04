BEGIN;

-- Restore tenant-runtime access needed by authoritative orchestration replay.
-- Receipt/checkpoint tables remain append-only for the runtime role.
GRANT SELECT,INSERT,UPDATE ON orchestration_runs TO getdone_tenant_runtime;
REVOKE DELETE ON orchestration_runs FROM getdone_tenant_runtime;
GRANT SELECT,INSERT ON orchestration_transition_receipts TO getdone_tenant_runtime;
REVOKE UPDATE,DELETE ON orchestration_transition_receipts FROM getdone_tenant_runtime;
GRANT SELECT,INSERT ON orchestration_checkpoints TO getdone_tenant_runtime;
REVOKE UPDATE,DELETE ON orchestration_checkpoints FROM getdone_tenant_runtime;

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-28.9z')
ON CONFLICT (version) DO NOTHING;

COMMIT;
