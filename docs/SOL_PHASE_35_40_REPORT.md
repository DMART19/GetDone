# Sol Phase 35/40 Deterministic Economics and Policy Simulation Report

This report records the GPT-5.6 Sol deterministic tranche for Phase 35 and Phase 40. It intentionally does not claim Phase 33/34 reservation or dispatch, live billing integration, production historical analytics, or automatic policy mutation.

## Phase 35 — Cost and Capacity Governor

Implemented:
- capacity economic classes: owned, committed, reserved, spot/preemptible, and variable/on-demand;
- hash-bound economic snapshots scoped to resource/portfolio/company;
- total, used, reserved, requested, protected-headroom, quota, effective-cost, marginal-cost, utilization, freshness, and expiry fields;
- economic evaluation consumes authoritative Phase 32 candidate results and cannot make an ineligible resource eligible;
- protected headroom and quota violations block economics even if a candidate is cheapest;
- budget binding supports deterministic ALLOW, APPROVAL_REQUIRED, and BLOCKED outcomes;
- only ALLOW candidates enter autonomous economic ranking;
- APPROVAL_REQUIRED candidates remain separate and cannot silently become autonomous choices;
- deterministic ranking uses effective cost, marginal cost, utilization, then resource ID as a stable tie-break;
- job/resource reconciliation compares estimated versus actual cost and usage with an integrity hash.

Authority boundary:
- economics is a preference layer, not a hard-policy bypass;
- no reservation, allocation, capacity mutation, provider purchase, or dispatch occurs;
- budget approval requirements remain subject to the existing decision/approval authority model.

## Phase 40 — Resource Intelligence and Zero-Side-Effect Policy Simulator

Implemented:
- scoped historical observations for placements, cost, utilization, queueing, failure, verified outcomes, and AI Gateway route/cost/latency/success;
- history from another company is excluded;
- historical facts are returned under `historical-summary`;
- projections are returned separately under `simulation-projection`;
- proposed resource policy is evaluated through the existing Phase 31 policy and Phase 32 placement evaluator;
- proposed economics/budgets are evaluated through the existing Phase 35 governor;
- scheduler changes are simulated with explicit cost/reliability/capacity weights and optional preferred regions;
- simulated scheduler order contains only placement-eligible, non-blocked resources and remains advisory;
- guardrails can simulate minimum eligible candidates, minimum eligible CPU capacity, maximum projected failure rate, and maximum expected cost;
- output includes explicit assumptions and uncertainty based on historical sample sizes and missing economic snapshots;
- AI recommendation mode requires AI Gateway evidence containing request ID, provider, model, routing-policy version, and evidence ID;
- no raw secret lookup exists in the simulator contract.

Hard zero-side-effect guarantees in the result:
- `policyMutationApplied: false`
- `reservationAttempted: false`
- `dispatchAttempted: false`
- `secretLookupAttempted: false`
- `automaticPolicyPromotion: false`
- `sideEffects: []`

## CI acceptance

The tranche is intended to pass the repository's full existing gate:
- runtime verification;
- secret-pattern scan;
- TypeScript;
- ESLint;
- Vitest;
- Next.js production build.

## Canonical production boundary

This tranche closes the deterministic logic for Phase 35 and Phase 40, but canonical production acceptance still requires real reservation/scheduler state where applicable, durable billing and usage feeds, persistent historical analytics, measured projection calibration, and end-to-end production evidence. The simulator remains permanently advisory and cannot promote its own recommendations.
