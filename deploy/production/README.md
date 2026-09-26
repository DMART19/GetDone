# GetDone production deployment

The production topology is declared by `topology.json` and `kubernetes.template.json`. No production secret value is committed to the repository.

Render manifests with `npm run deploy:render -- --phase=migration` or `--phase=runtime`. The renderer requires immutable web/worker image digests, a managed PostgreSQL URL, production WebAuthn hostname inputs, OpenRouter routing inputs, observability, and at least one governed integration. It writes the rendered Kubernetes JSON manifest to stdout and never logs decoded secret values.

Rollout order is migration first, then runtime. Apply the migration manifest and require the `getdone-db-migrate` Job to succeed before applying the runtime manifest. The runtime definition keeps at least two web and worker replicas, uses zero-unavailable rolling updates, readiness/startup/liveness probes, disruption budgets, HPA bounds, TLS-only ingress, non-root/read-only containers, and default-deny network policy with explicit DNS, HTTPS, and PostgreSQL egress.

During disaster recovery, do not start workers merely because the restored database is reachable. Persist the disaster-recovery Job plan first. Active `reconcile` and `blocked` decisions are enforced by the durable Job store and prevent queue/recovery replay until reconciliation evidence clears an eligible hold.


## Zero-downtime database rollout

Production schema changes follow `expand -> migrate -> contract`.

1. **Expand** first. Only additive/backward-compatible schema changes may run while the previous application fleet is still serving traffic.
2. Run `npm run db:test-zero-downtime`. The acceptance checks out the exact previous release commit, runs that code against the expanded transition schema, runs the candidate code against the same transition schema, and compares authoritative entity/audit/Job semantics.
3. **Migrate** data only with resumable, idempotent, bounded backfills or dual-write/shadow-read transitions. Authority hashes and verification evidence must remain valid.
4. Deploy the candidate application with zero-unavailable rolling policy.
5. Drain and verify the previous application fleet is gone.
6. **Contract** destructive schema only in a later release, after transition verification and a fresh verified backup. Drops, renames, type narrowing, and new NOT NULL requirements are prohibited in expand/migrate phases.

The machine-enforced policy lives at `config/zero-downtime-migration-policy.json`; `npm run verify:zero-downtime-migrations` fails closed on policy drift or destructive SQL in a non-contract phase.

## Production promotion

Production promotion is manual and fail-closed through the **Production Release Gate** workflow. The candidate must already be contained in `main` and identified by an exact commit SHA. The gate binds exact-SHA CI/PostgreSQL evidence to fresh production-like PostgreSQL/backup verification, authoritative staging browser E2E, live OpenRouter acceptance, a controlled real-HTTPS integration canary, worker readiness, vulnerability scanning, contract drift verification, zero-downtime migration policy, and release-manifest integrity.

The final command is `npm run release:gate-production`. A passing result is persisted as `production_release_gate_evidence` for the candidate SHA. Production promotion must not proceed without that evidence.
