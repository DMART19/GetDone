# GetDone staging engineering acceptance report — 2026-10-14

Scope: DMART19/GetDone, PR #131, staging/getdone-unified-acceptance-20261014. Production unchanged.

## Eight-task results
1. CI investigation: GitHub Actions run 38679616505 on 88baab72 completed successfully. Full Vitest suite, worker and orchestration builds, typecheck, lint, Next.js build, architecture/secrets gates, David Edition desktop/mobile Playwright all passed. Newer n8n rejection tests at fbe135a8 require a fresh CI pass.
2. Conversation audit: lib/conversation/acceptance.test.ts exercises follow-up context (Why?), topic switching, business switching, action ambiguity, serialization/recovery, evidence ranking, missing connections, tenant/sensitivity filtering and revoked membership. This is automated fixture coverage, not a real owner session.
3. TLS: lib/persistence/postgres/tls.ts fails closed on invalid PGSSLROOTCERT and preserves rejectUnauthorized:true; unit tests cover hostile URL SSL overrides. Backup script corrected to use shared TLS helper at df68d92. Render worker logs around 2026-10-15T05:10Z still report SELF_SIGNED_CERT_IN_CHAIN; no runtime CA trust configured by this PR.
4. Release compatibility: staging web branch staging/david-edition-conversation-integration, existing worker branch codex/narrow-optimization-addendum. The staging branch is 25 commits ahead, 0 behind. Both workers are production-oriented services; do not repoint or deploy them to staging. Dedicated staging workers with staging-only credentials and same reviewed SHA are required.
5. Authorization/tenant isolation: acceptance tests assert business-switch context clearing, unauthorized evidence exclusion, revoked membership blocking submission, and no approval from action selection. Staging has 0 auth_owner_enrollments, 0 auth_webauthn_credentials, 0 authorization_grants and 0 authorization_consumptions; live passkey and approval test blocked.
6. n8n: lib/operations/n8n-envelope-validator.ts requires HMAC, recent timestamp, owner scope, registered capabilities and repositories, preview hash for branch creation and protected-branch rejection. Existing tests passed in CI; added missing-signature, expired-envelope and unsupported-capability regression tests in fbe135a8, pending CI. Actual workflow receipts not independently verified.
7. Backup: staging database_backup_evidence contains one record status verified, completed 2026-10-14T19:46:36Z, verification hash present, migration 2026-10-10.1. Migration ledger includes staging_verified_backup_runtime_read_policy (20261014200119). Backup file/manifest and isolated restoration have not been inspected or independently proven. The repo contains db:test-backup-restore but it requires a controlled PostgreSQL admin test environment and creates/drops isolated test databases. Never run it against production or staging DB without explicit safety verification.
8. Launch decision: NOT ACCEPTED. Worker TLS startup failure, dedicated staging worker isolation, owner passkey, backup restore evidence, live conversational execution and independent receipts remain blocking.

## Commits
- df68d92: backup script uses shared verified TLS helper
- 88baab72: unified CI test and worker build gates
- fbe135a8: n8n negative-path regression tests

## Required next actions
- Wait for latest CI completion and fix failures if any.
- Obtain operator-verified Supabase CA chain and mount it securely on dedicated staging workers; validate hostname and chain without disabling TLS.
- Deploy only staging-isolated workers and web from same reviewed SHA after backups and isolation are confirmed.
- Complete owner WebAuthn enrollment and run real governed end-to-end acceptance with receipts.
- Independently restore a backup in an isolated test environment and verify hashes, invariants and application boot.
