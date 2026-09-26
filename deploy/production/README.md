# GetDone production deployment

The production topology is declared by `topology.json` and `kubernetes.template.json`. No production secret value is committed to the repository.

Render manifests with `npm run deploy:render -- --phase=migration` or `--phase=runtime`. The renderer requires immutable web/worker image digests, a managed PostgreSQL URL, production WebAuthn hostname inputs, OpenRouter routing inputs, observability, and at least one governed integration. It writes the rendered Kubernetes JSON manifest to stdout and never logs decoded secret values.

Rollout order is migration first, then runtime. Apply the migration manifest and require the `getdone-db-migrate` Job to succeed before applying the runtime manifest. The runtime definition keeps at least two web and worker replicas, uses zero-unavailable rolling updates, readiness/startup/liveness probes, disruption budgets, HPA bounds, TLS-only ingress, non-root/read-only containers, and default-deny network policy with explicit DNS, HTTPS, and PostgreSQL egress.

During disaster recovery, do not start workers merely because the restored database is reachable. Persist the disaster-recovery Job plan first. Active `reconcile` and `blocked` decisions are enforced by the durable Job store and prevent queue/recovery replay until reconciliation evidence clears an eligible hold.
