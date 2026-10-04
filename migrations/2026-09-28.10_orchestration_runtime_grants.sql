BEGIN;

-- Restore least-privilege grants required by tenant-scoped authoritative
-- orchestration persistence. Immutable evidence remains append-only.
GRANT SELECT,INSERT,UPDATE ON orchestration_runs TO getdone_tenant_runtime;
REVOKE DELETE ON orchestration_runs FROM getdone_tenant_runtime;
GRANT SELECT,INSERT ON orchestration_transition_receipts TO getdone_tenant_runtime;
REVOKE UPDATE,DELETE ON orchestration_transition_receipts FROM getdone_tenant_runtime;
GRANT SELECT,INSERT ON orchestration_checkpoints TO getdone_tenant_runtime;
REVOKE UPDATE,DELETE ON orchestration_checkpoints FROM getdone_tenant_runtime;

INSERT INTO getdone_schema_migrations(version) VALUES ('2026-09-28.9zz')
ON CONFLICT (version) DO NOTHING;
COMMIT;
