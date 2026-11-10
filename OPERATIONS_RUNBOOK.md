# GetDone operations runbook

Complete environment-specific values before production enablement. Keep credentials in the deployment secret store; record secret names and rotation owners only.

## Ownership and escalation

- Service owner:
- On-call contact:
- Database owner:
- Provider integration owner:
- Incident channel/contact:
- Last reviewed:

## Health and alerts

- Web/API health endpoint and expected response:
- Worker heartbeat source and stale threshold:
- Queue backlog and dead-letter thresholds:
- Database connection and saturation alerts:
- Provider error-rate alerts:
- Alert destination and acknowledgement expectation:

## Safe stop and recovery

1. Disable new external actions using the documented kill switch.
2. Revoke affected provider credentials in the provider console if compromise is suspected.
3. Preserve correlation IDs, audit records, and timestamps; do not copy secret values or private payloads into incident notes.
4. Inspect worker leases, retries, dead-letter records, and last successful backup.
5. Restore or fail over only using the approved database recovery procedure.
6. Re-enable actions only after an owner confirms the cause is contained and staging acceptance passes.

## Release and rollback record

- Release commit and CI run:
- Enabled integrations and capabilities:
- Database migration set:
- Backup identifier and restore verification:
- Rollback or forward-fix steps:
- Operator and completion time:
- Post-deployment health evidence:

A runbook is not evidence of a completed drill. Attach dated results from staging exercises before release.
