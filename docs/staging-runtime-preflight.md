# GetDone staging runtime preflight — private operator check

This check runs **inside each Render staging service's private shell**, after staging-only credentials and the trusted CA have been configured. It prints no secrets or connection strings and does not change the database.

## Prerequisites

- Confirm the service is **staging-only**, not one of the existing production-linked suspended workers.
- Set `GETDONE_RUNTIME_ENV=staging`, `GETDONE_DATA_MODE=authoritative`, `GETDONE_DB_SSL=true`, `GETDONE_DB_RUNTIME_ROLE=getdone_tenant_runtime`, and the appropriate `GETDONE_PROCESS_ROLE` (`web`, `job-worker` or `orchestration-worker`).
- Configure staging-only `DATABASE_URL` and `GETDONE_INTERNAL_WORKER_TOKEN` privately. The staging database reference must be `ddxjiszbsmmbqxuoecmg`. The check accepts the exact project direct host or the approved `aws-1-ca-central-1.pooler.supabase.com` host with `postgres.ddxjiszbsmmbqxuoecmg` username.
- Provision the genuine trusted X.509 CA chain at the path named by `PGSSLROOTCERT` on **each** staging service. Static validation checks only that the PEM is readable and currently valid; the optional network probe establishes actual TLS chain and hostname validation.

Run from the checked-out GetDone project root in the staging shell:

```sh
node scripts/verify-staging-runtime-config.mjs
node scripts/verify-staging-runtime-config.mjs --connect
```

The first command checks only the intended staging target and local settings; it is **not** proof that the service can connect. The second performs a **read-only** `SELECT 1` over PostgreSQL TLS with certificate verification enforced. Its explicit PASS output establishes connectivity for that service.

If the check fails, correct settings in Render's **private secret-management interface**. Do not paste environment values into chat, screenshots, pull requests, test logs or GitHub Actions. Do not run it on production or use a TLS bypass.

## After preflight

A working PostgreSQL connection is necessary but **not sufficient** for owner-only acceptance:

1. Obtain a **fresh, genuine** staging backup and independently verify its restore on an isolated disposable database. Never forge freshness metadata.
2. Confirm schema migration and runtime RLS verification, actual service health and matching reviewed source SHA for web plus the two dedicated staging workers.
3. Enroll the owner's passkey on the owner's device.
4. Import the inactive **staging** n8n exports following `docs/staging-n8n-import.md`.
5. Capture independent signed approval, action, receipt, replay/denial and restart-recovery evidence.

The existing `render.yaml` is **production-oriented**. Do not apply it wholesale to staging or repurpose production-linked background workers.
