# Sol Quality Hardening — V8 Coverage, Playwright, and AI Budget Reservations

## Scope

This tranche hardens three code-quality gaps without claiming production infrastructure that is not connected.

### 1. Real executable coverage

- Vitest V8 coverage is now the executable coverage authority.
- CI enforces statement, line, function, and branch thresholds.
- The existing architectural module-to-test mapping remains a separate gate; it is no longer treated as executable code coverage.
- Coverage HTML and JSON summary evidence are archived from CI.

Current configured minimums:

- statements: 80%
- lines: 80%
- functions: 75%
- branches: 75%

### 2. Browser/mobile E2E

Playwright now exercises the existing owner surface in both desktop Chromium and iPhone-sized Chromium emulation.

Covered behaviors include:

- permanent Chat / Decisions / Resources navigation;
- Decisions and Resources content;
- Add Resource flow;
- direct decision/resource deep links;
- unknown scoped IDs failing closed to Not found;
- development health/resources/decisions API envelopes;
- chat and decision controls remaining preview-only;
- PWA manifest;
- service-worker registration;
- minimal offline-shell caching;
- proof that API paths are not placed in service-worker caches;
- browser offline notice;
- explicit offline route;
- controlled offline navigation fallback when the browser has acquired service-worker control.

This remains UI/runtime acceptance for the existing development surface, not production auth or production job acceptance.

### 3. AI Gateway terminal failures and budget authority

AI Gateway contract version is now 1.1.0.

Terminal invocation failures preserve typed reasons:

- NO_ELIGIBLE_MODEL
- ADAPTER_UNAVAILABLE
- MODEL_CALL_FAILED
- MODEL_IDENTITY_MISMATCH
- SCHEMA_INVALID

The new atomic AI budget reservation contract adds:

- company + portfolio + period scoping;
- atomic reservation authority;
- idempotent replay;
- idempotency conflict detection;
- reservation integrity hashing;
- expected-hash settlement;
- commit of actual cost;
- exact-once release of unused/reserved budget;
- production-store descriptor requirements for durability, CAS, restart safety, and multi-process safety;
- deterministic concurrency tests proving two concurrent reservations cannot both overspend the same remaining budget.

The included memory store is test-only and explicitly non-production. No live AI Gateway, database, or distributed budget ledger is claimed by this tranche.

## CI evidence required

The tranche is accepted only when the PR pipeline passes:

- runtime verification
- secret scan
- architecture verification
- contract-version drift verification
- TypeScript
- ESLint
- Vitest V8 coverage thresholds
- architectural module test-map gate
- Next production build
- Playwright desktop + mobile Chromium suite
- release artifact generation and verification
