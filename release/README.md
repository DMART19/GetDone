# Phase 41 Release Evidence

This directory contains the committed, machine-readable release anatomy for GetDone.

## Committed inputs

- `version-registry.json` — app/schema/policy/database/adapter/AI-routing/voice version registry and evidence/manual source list.
- `environment-manifest.json` — explicit development/staging/production deployment, infrastructure connection state, and Phase 42 voice contract/live-adapter authority state.

These files contain declarations and references only. They must never contain raw credentials.

The machine-readable formats are versioned explicitly: version registry schema `1.2.0`, environment manifest schema `1.2.0`, and generated release manifest schema `1.2.0`.

## Generated per checkout/release

Run:

```bash
npm run release:generate
npm run verify:release
```

The generator writes ignored artifacts under `release/out/`:

- `release-manifest.json` — binds the current checked-out Git SHA to app version, package lock, schema source hashes, policy versions/source hashes, database migration/schema state, AI Gateway deterministic/live state, Integration Registry state, durable Job/business-action/software-deployment contract/live state, Phase 42 voice state, adapter versions/source hashes, environment manifest, CI evidence, generated control-plane coverage evidence, acceptance evidence, and manual hashes.
- `OPERATING_MANUAL.md` — human-readable reconstruction of the same release anatomy and release flow.

GitHub Actions generates and verifies these artifacts after the normal build gate, then archives them with `actions/upload-artifact`. Pull-request evidence binds the checked-out merge/test commit used by Actions; main-branch evidence binds the pushed main commit.

The generated manifest is intentionally not committed because a commit cannot contain its own final Git SHA without becoming self-referential. The committed registry is stable input; the generated CI artifact binds that input to the exact checked-out SHA.

## Production-readiness rule

A generated artifact may accurately describe a non-production-ready release. Phase 41 does not promote deterministic foundations to production readiness. The environment manifest must remain fail-closed until real infrastructure acceptance exists. Because Phase 42 is included in release scope, production readiness also requires a real connected voice adapter; the current registry deliberately records that adapter/provider as unimplemented/unconfigured.


## Contract and quality evidence

Tracked contract source paths are marked in `version-registry.json`. `npm run verify:contract-versions` fails when an established tracked contract changes without a semantic-version bump.

`npm run verify:coverage` generates a dependency-free module/test-contract coverage report for critical control-plane boundaries. CI archives that report with the release manifest/manual and release verification binds its SHA-256.
