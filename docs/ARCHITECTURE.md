# GetDone architecture baseline

## Current repository shape

GetDone remains a single Next.js TypeScript repository while the deterministic control-plane contracts are built ahead of production infrastructure. That is an implementation packaging choice, not an authority shortcut.

### Owner experience

The permanent owner navigation is intentionally fixed at:

**Chat · Decisions · Resources**

Backend/resource complexity must not turn the product into an infrastructure admin console.

### Implemented deterministic boundaries

- screenshot-aligned iPhone-first owner shell;
- typed Control API envelopes and trusted execution scope;
- auth/session and step-up contracts;
- policy, authorization grants, approval proofs, Tasks/Jobs/Outcomes/Events;
- Phase 22 verification receipts plus authoritative verifier-source trust attestations;
- Phase 23 advisory memory;
- Phase 25 PWA/service worker, safe deep links, notifications, and WebAuthn ceremony boundary;
- Phase 26/27 Resource Registry and enrollment contracts;
- Phase 29 minimum-scope credential leases;
- Phase 30 profiling/telemetry contracts;
- Phase 31 hard resource/data policy;
- Phase 32 placement eligibility;
- Phase 33 reservation/capacity-ledger CAS contracts;
- Phase 34 scheduler/dispatch contracts;
- Phase 35 cost/capacity governor;
- Phase 40 zero-side-effect simulator.

### Architecture-integrity composition

The authoritative resource-execution path is now constrained to:

```text
authorized Job
  -> Phase 32 hard placement eligibility
  -> Phase 35 cost/capacity governor admission
  -> Phase 34 bounded preference ranking
  -> Phase 34 placement decision
  -> Phase 33 reservation + pending allocation
  -> Phase 29 scoped credential lease
  -> final dispatch-admission receipt
       - current policy registry
       - current kill switches
       - READY/environment permission
       - governor freshness/admission
       - reservation freshness
       - credential freshness/scope
  -> resource adapter dispatch
  -> trusted independent verifier-source attestation
  -> verified running placement
  -> monitoring
  -> trusted completion verification
  -> Phase 33 exact-once release
```

Provider `accepted`, HTTP success, resource-agent claims, model output, and frontend state are evidence only. They do not establish Job success, placement truth, verification truth, approval, policy mutation, or production authority.

### AI boundary

OpenRouter/model integration is intentionally absent from feature code today. When Phase 13 production integration begins, runtime feature code must call a GetDone-owned AI Gateway. Provider/model SDK imports and provider HTTP endpoints are forbidden outside that boundary by `npm run verify:architecture`.

### Browser boundary

The browser cannot approve production actions, set Job/resource truth, enroll infrastructure authoritatively, store production secrets, choose its own trusted scope, or execute model/provider work.

Development seed data is confined to the development read-repository seam and fails closed outside allowed runtime modes.

### CI architecture gate

`npm run verify:architecture` protects high-value invariants, including:

- permanent Chat / Decisions / Resources navigation;
- the authority rule in README;
- provider/model SDK isolation behind `lib/ai-gateway`;
- no secret-like `NEXT_PUBLIC_*` variables;
- DEVELOPMENT seed-data import isolation;
- zero-side-effect simulator isolation from reservation/dispatch/credential modules;
- Phase 34 governor, credential, admission, trusted-verifier, and Job-truth bindings;
- no stale architecture documentation claiming the Phase 25 service worker is still deferred.

The drift gate is additive to secret scan, TypeScript, lint, unit tests, and production build.

## Production status

Deterministic code is not production autonomy. Production acceptance still requires real authentication/persistence/RLS, durable jobs, live AI Gateway, live resource agents/telemetry, transactional Phase 33 persistence, real adapters/probes, billing feeds, storage/failover, and end-to-end acceptance evidence.
