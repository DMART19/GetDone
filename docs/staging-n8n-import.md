# GetDone n8n staging import (isolated, inactive)

The three authoritative files under `n8n/` are **production-targeted templates**. Their validator URL is `https://getdone-web.onrender.com/api/integrations/n8n/validate`. **Do not import those templates directly into the staging acceptance environment** or send staging-signed actions to the production endpoint.

## Prepare the staging bundle

From the reviewed GetDone candidate checkout:

```sh
export GETDONE_N8N_STAGING_EXPORT="$(mktemp -d)"
node scripts/export-staging-n8n.mjs "$GETDONE_N8N_STAGING_EXPORT"
```

The export creates exactly three **inactive** workflow JSON files with the same narrow capabilities:

- `github_repository_health.json` → `getdone-staging-github_repository_health`
- `deployment_health.json` → `getdone-staging-deployment_health`
- `github_create_branch.json` → `getdone-staging-github_create_branch`

Each exported guard targets **only** `https://getdone-web-staging.onrender.com/api/integrations/n8n/validate`, and webhook paths use `getdone-staging-...` to avoid collisions with the production paths when a shared n8n host is used. The exporter fails closed if the authoritative templates change or destination files already exist. It never edits source templates or the live n8n server.

## Operator staging checklist

1. Verify the candidate branch SHA and passing CI for that exact SHA before using these exports.
2. Keep all three workflows **inactive** when importing. Confirm their webhook paths and `Validate governed envelope` target the staging Render hostname, not production.
3. Provision **separate staging** n8n GitHub credentials authorized only for the permitted staging/test repository and a non-protected acceptance branch. Do not bind production GitHub credentials or workflow webhook URLs.
4. Privately configure staging-only signing key and scoped owner/portfolio/company IDs on the staging validator. The staging key must not be the production key. Config keys include `GETDONE_N8N_SIGNING_KEY`, `GETDONE_OWNER_USER_ID`, `GETDONE_OWNER_PORTFOLIO_ID`, `GETDONE_OWNER_COMPANY_ID`, `GETDONE_RUNTIME_ENV=staging`, and registered workflow JSON for the allowed resources. Never paste values into GitHub, logs or chat.
5. Validate secure PostgreSQL TLS and the actual staging `DATABASE_URL`, the fresh backup and isolated restore evidence, staging passkey login, and worker startup. Keep `GETDONE_N8N_ENABLED=false` until the acceptance operator has verified these prerequisites.
6. Register the *staging export* webhook URLs as scoped workflow URLs in GetDone staging and perform a signed read-only repository health test first.
7. Only then enable and test one **approved** staging branch creation with independent GitHub GET verification, denied-approval test, replay attempt, wrong-tenant test, and worker recovery. Record redacted requests and receipts. Do not use `main`, `master`, protected branches or production deployment as an acceptance target.

## Failure rules

- If the staging validator is unhealthy, **stop**. Do not point the export at production as a workaround.
- Signing, owner scope, request time and preview hash must be rejected when invalid. A signed payload alone does **not** replace durable approval-consumption and idempotency checks. Require live acceptance evidence for replay safety.
- Imported n8n workflow JSON is not evidence of live workflow success. The code-level contract tests and CI are simulated; owner-only launch remains blocked until real execution and independently observed receipts pass.
