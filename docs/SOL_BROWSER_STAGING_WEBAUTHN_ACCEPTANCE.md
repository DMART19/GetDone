# Production browser and WebAuthn staging acceptance

Date: 2026-09-24

## Requirement 20 — authoritative staging browser E2E

The development-seed Playwright suite remains for fast UI regression, but it is no longer the only browser acceptance surface.

`playwright.staging.config.ts` runs Chromium against:

- `GETDONE_RUNTIME_ENV=staging`;
- `GETDONE_DATA_MODE=authoritative`;
- PostgreSQL 16;
- real server-side membership/session resolution;
- real Control API reads/mutations;
- real passkey sign-in and fresh step-up;
- the durable PostgreSQL Job queue/worker;
- provider execution and independent verification evidence.

The golden-path browser test performs:

1. sign in with a Chromium virtual passkey;
2. submit an owner intent through the actual Chat composer;
3. confirm the intent is persisted in PostgreSQL;
4. materialize the controlled staging Decision from that persisted correlation lineage;
5. receive and open the authoritative Decision in the browser;
6. approve it, triggering the real passkey step-up ceremony;
7. create an authoritative Task and Job with a persisted authorization grant/consumption;
8. enqueue the Job through `MvpJobRuntime`;
9. execute a controlled safe integration that performs a real HTTP read of `/api/health`;
10. verify the resulting provider operation through the business-action verification path;
11. persist a verification receipt;
12. advance the authoritative Job record to `succeeded`;
13. render `/operations/jobs/[id]` and prove the browser shows authoritative completion, evidence, receipt, and the original correlation ID.

The staging test driver lives under `e2e/staging/support.ts`. It is test code only and does not add a production mutation route or bypass the production Control API.

## Requirement 21 — complete WebAuthn browser ceremony

`e2e/staging/webauthn.spec.ts` uses Chromium's DevTools Protocol virtual authenticator with a generated P-256 credential. The matching public key is persisted in the real `auth_webauthn_credentials` table.

The browser suite covers:

- successful sign-in;
- successful fresh step-up;
- sign-in challenge replay;
- step-up challenge replay;
- wrong origin;
- wrong RP ID hash;
- stale/expired challenge;
- wrong credential ID;
- signature-counter rollback;
- missing user verification;
- revoked session during step-up;
- expired step-up proof rejected for a strong Decision.

The browser generates genuine WebAuthn assertions for the valid paths. Adversarial tests mutate the minimum relevant assertion field when the server is expected to reject before signature verification.

## Cookie transport

Production continues to require Secure authentication cookies.

The authoritative browser CI harness runs on `http://localhost`, which WebAuthn permits as a secure-context exception. It explicitly sets:

`GETDONE_AUTH_COOKIE_SECURE=false`

Production runtime validation rejects that setting. The runtime default remains `true`.

## CI

`.github/workflows/browser-staging-acceptance.yml`:

- starts PostgreSQL 16;
- runs all migrations;
- installs Chromium;
- launches GetDone in authoritative staging mode;
- runs the golden-path and WebAuthn browser acceptance;
- uploads Playwright traces/screenshots/results on failure.

This workflow is separate from the fast development-seed Playwright suite so both surfaces remain independently visible.
