# Phases 9–12 — Sensing and Intelligence Foundation

This report follows the canonical OpenRouter / multi-model scoped build plan. It records deterministic repository work only and does not claim cloud runtime, database persistence, scheduled research infrastructure, or model authority that is not actually connected.

---

## Phase 9 — Unified Signal Bus

**STATUS: OWNER ACTION REQUIRED**

### Implemented

- Added a real `SignalBusService` contract.
- Added strict runtime ingestion validation.
- Removed caller-supplied company/resource authority from the ingest envelope.
- Added trusted `SignalScopeResolver` source-binding resolution.
- Added normalized signal provenance.
- Added durable dedupe/cursor/signal store interfaces.
- Added `SignalBusPersistence.run(...)` transaction boundary so dedupe claim + signal append + cursor advancement are intended to commit atomically.
- Added explicit out-of-order event detection.
- Late events are retained but do not regress stream cursors.
- Added resource signal vocabulary:
  - resource.added
  - resource.ready
  - resource.offline
  - resource.degraded
  - resource.saturated
  - resource.capacity-low
  - resource.cost-spike
  - resource.failover
  - resource.credential-failure
  - resource.policy-violation
  - resource.drain-started
  - resource.drain-complete
- No AI/model call occurs during signal ingestion.

### Tests

- invalid ingestion is rejected
- caller-supplied `companyId` is rejected
- trusted source binding determines company/resource scope
- duplicate provider event produces one logical signal
- out-of-order event is retained without cursor regression
- failed signal persistence rolls back the dedupe claim
- unknown source binding is rejected

### Owner / infrastructure action required for canonical PASS

Connect these interfaces to durable server-side persistence and an always-on ingestion runtime. The repository does not yet prove the build-plan acceptance condition that signal ingestion continues while all client devices are offline.

---

## Phase 10 — Sensing Engine and Deterministic Attention Filtering

**STATUS: OWNER ACTION REQUIRED**

### Implemented

- Added deterministic `SensingEngine`.
- Added company-scoped and resource-specific `SensingProfile` configuration.
- Added `ScopedSensingProfileResolver` with resource-specific profile precedence over company fallback.
- Added configurable:
  - baseline value
  - increase/decrease/either risk direction
  - monitor threshold
  - investigate threshold
  - escalate threshold
  - sample window
  - minimum samples
  - sustained duration
  - freshness limit
  - investigation cooldown
- Added profile validation.
- Added deterministic resource attention rules.
- Added stale-signal handling.
- Added `Investigation` domain model.
- Added `InvestigationCoordinator`.
- Existing open investigations receive matching signals instead of creating duplicates.
- Non-critical investigation recreation is suppressed during cooldown.
- Escalations are allowed to break cooldown rather than hide a critical event.
- No web research or model reasoning occurs in sensing.

### Tests

- normal fluctuations are ignored
- sustained deviations create INVESTIGATE
- resource policy violations ESCALATE
- stale signals are recorded without investigation
- invalid threshold configuration fails closed
- resource-specific baseline overrides company fallback
- matching signals update an existing investigation
- cooldown suppresses repeated non-critical investigation creation

### Stabilization hardening

Phase 10 sensing evidence was hardened on the launch-blocker stabilization branch:

- sustained anomaly evidence now counts only threshold-consistent recent samples;
- recent evidence must match portfolio, company, resource, signal type, and configured metric;
- future-dated and out-of-window samples cannot satisfy sustained evidence;
- normal samples cannot inflate an investigation/escalation sample count;
- profiles fail closed when the sensing window, minimum sample count, or freshness limit is zero;
- profiles fail closed when sustained duration exceeds the configured sensing window;
- regression coverage now exercises false-sustained, cross-resource, future-sample, and invalid-window cases.

### Owner / infrastructure action required for canonical PASS

Persist sensing profiles, recent-signal windows, and investigations in authoritative storage and run sensing continuously in an always-on backend runtime. Until then, continuous client-independent sensing is a tested contract rather than a deployed service.

---

## Phase 11 — External Intelligence Missions

**STATUS: OWNER ACTION REQUIRED**

### Implemented

- Expanded `ResearchMission` for scoped company/objective research.
- Added purposes for competitors, pricing, SEO, keywords, market, technology, and public customer signals.
- Added per-run request and cost limits.
- Added rolling rate-window request and cost limits.
- Added deterministic quota evaluation.
- Added optimistic durable `ResearchQuotaStore` interface.
- Research allowance is denied before a provider request when a hard limit would be exceeded.
- Research evidence is permanently marked `authority: "advisory"`.
- Added unverified/corroborated claim status without converting evidence into GetDone authority.
- Added freshness labeling and invalid/future timestamp handling.
- Added `runAdvisoryResearch` failure isolation so provider/research failures return non-authoritative failure results with `coreOperationsAffected: false`.

### Tests

- company/objective scope enforcement
- stale evidence detection
- per-run request limit
- per-run cost limit
- rolling request rate limit
- rolling cost limit
- optimistic quota reservation
- provider failure isolation from core operations

### Owner / infrastructure action required for canonical PASS

Connect an actual scheduled research runtime, durable quota store, and real external-research adapter. No web/research provider is represented as connected by this repository.

---

## Phase 12 — Context Assembler

**STATUS: PASS**

### Implemented

- Added freshness filtering before context admission.
- Added strict portfolio/company scope filtering.
- Added sensitivity filtering.
- Added explicit resource-summary authorization through `allowedResourceIds`.
- Unauthorized resource details do not enter assembled context.
- Added bounded context by:
  - total item count
  - total character count
  - per-section item count
- Added typed context sections:
  - facts
  - signals
  - outcomes
  - decisions
  - policies
  - capabilities
  - resource summaries
- Preserved source, provenance, freshness, company attribution, resource attribution, and sensitivity on every included item.
- Portfolio context can preserve multiple company attributions without flattening them into one company.
- Added exclusion counters for stale, unauthorized-scope, sensitivity, resource-scope, and size exclusions.
- No model receives authority from context assembly.

### Tests

- stale context is excluded
- Company A context excludes Company B private details
- resource summaries require explicit resource authorization
- typed sections preserve provenance and company attribution
- global character budget is enforced
- per-section item budgets are enforced

### Deferred

- No model invocation.
- No OpenRouter gateway.
- No prompt-specific transformation beyond the bounded GetDone-owned context structure.
- Resource summaries remain domain placeholders until authoritative Resource Fabric data exists.

---

## Overall result

The repository now has a substantially stronger Milestone B deterministic substrate:

`authenticated source -> validated ingest -> trusted scope -> atomic dedupe/normalize/cursor -> deterministic sensing -> bounded investigation -> advisory research controls -> fresh authorized context`

The next high-compute boundary remains Phase 13: the provider-neutral AI Gateway / OpenRouter model router. The deterministic systems implemented here remain authoritative before and after that gateway is introduced.
