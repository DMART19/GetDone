# GetDone production commissioning — verified blockers (2026-10-08)

## Evidence, not assumptions
- Render workspace: My Workspace; web service: getdone-web (srv-db24imei0phs73d93p20), branch main, automatic deployments enabled.
- Last observed deploy dep-db3dssgbr16s73e2gn0g: **build succeeded**, deployment **failed**.
- Render application log: startup `scripts/verify-production-runtime.mjs` rejects configuration with `INTEGRATION_CONFIG`: no governed ordinary production integration configured.
- The existing GitHub connector for ChatGPT is **not** GetDone's own production GitHub App credential or broker configuration.
- GitHub PR #120 CI run 37858028648 fails dependency security audit (sharp, source-map-js, tinypool, vitest). Do not disable audit; update lockfile and dependencies with validated compatible patched versions and rerun tests.
- Only getdone-web appears in the workspace service listing. Dedicated job and orchestration workers have not been deployed there.
- The read-only solar system is on PR #120, **not main**, and only shows registered resources. Product-to-resource company graph is not yet verified.
- No live authenticated end-to-end smoke test has passed.

## Owner-only inputs/actions (do not send credentials in chat)
1. In Render getdone-web environment settings, configure an actual governed production integration. For GitHub use `GETDONE_GITHUB_ACTIONS_JSON` with the real bootstrapped `companyId`, a real `credentialProviderId`, and `repositories:["DMART19/GetDone"]`; configure the matching GitHub App installation, app ID, resource binding, broker delivery URL/token and web-only private signing key as described in `.env.example`. **Never insert fake values** or use a ChatGPT GitHub connector token as a substitute.
2. Confirm the production Supabase DATABASE_URL and least-privileged runtime role, completed migrations, restore-tested backup evidence, owner passkey/bootstrap and OpenRouter key/model profiles. The startup verifier will surface remaining failures once integration configuration passes.
3. Provide a real HTTPS OTLP collector endpoint and authorization if not already provisioned. The verifier requires observability.
4. Approve additional Render worker services/costs if needed; `render.yaml` defines `getdone-job-worker` and `getdone-orchestration-worker` using the same external Supabase database and shared runtime configuration. Do not create Render Postgres.

## Engineering work remaining (not owner credential tasks)
- Repair the dependency vulnerabilities and pass GitHub CI, typecheck, lint, build and browser tests.
- Connect tenant-scoped company/product membership to resources and integrations; expose evidence freshness and unknown states; do not hardcode OpsManagerPro or StatusWatchPro.
- Carry selected graph entity into chat via trusted conversation context, not untrusted message string concatenation.
- Merge reviewed PR only after checks pass.
- Deploy workers, verify startup readiness and background job execution; execute authenticated sign-in → chat → governed approval → job → verification smoke test.
- Verify backups, observability, health checks and rollback before marking production ready.

## Safety constraints
Never bypass startup guards, weaken authorization, mark unverified health green, expose provider secrets to browser bundles, or claim a successful launch without runtime evidence.
