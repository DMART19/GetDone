# Phases 14–18 — Deterministic Planning, Policy, Task, and DAG Foundation

This report follows the current OpenRouter / multi-model scoped build plan. It records only deterministic work implemented in the repository. It does **not** claim that the Phase 13 AI Gateway, production auth/database, durable job runtime, resource scheduler, or execution adapters exist.

## Phase 14 — Plan Construction

**STATUS: OWNER ACTION REQUIRED FOR CANONICAL PASS; DETERMINISTIC SUBSET IMPLEMENTED**

Implemented:
- GetDone-owned Zod plan schema.
- Objective / investigation / owner-request source trace.
- Authoritative portfolio/company/environment/data scope.
- Evidence and assumptions.
- Plan dependencies.
- Requested capabilities and typed capability requests.
- Expected outcomes.
- Plan/step estimated costs.
- Plan/step risk.
- Rollback / cancellation semantics.
- Verification requirements.
- Resource requirement envelopes that describe requirements rather than machine IDs.
- `constructPlanProposal` boundary that:
  - parses unknown/model output through the GetDone-owned schema;
  - requires server-authorized portfolio/company scope;
  - requires a server-authorized source reference;
  - freezes the resulting proposal;
  - grants no authorization.

Deferred:
- No model call.
- No OpenRouter adapter.
- No Phase 13 AI Gateway.
- No model-generated proposal is represented as production-connected.

Canonical Phase 14 still depends on the real AI Gateway path for model-originated proposals.

---

## Phase 15 — Plan Validator

**STATUS: DETERMINISTIC SUBSET PASS**

Implemented deterministic checks for:
- unsupported/disabled capabilities;
- capability input runtime schemas;
- authoritative scope mismatch;
- unknown dependencies;
- self-dependencies;
- dependency cycles;
- explicit step conflicts;
- contradictory unordered effects;
- duplicate logical work warnings;
- plan and step cost ceilings;
- plan cost underestimation versus step totals;
- environment constraints;
- data-class constraints;
- region constraints;
- minimum reliability tier;
- fallback requirements;
- credential-binding availability;
- high-risk rollback/mitigation owner decisions;
- declared-versus-used capability consistency.

The validator returns structured:
- errors;
- warnings;
- owner decisions;
- deterministic step order.

The validator never authorizes execution.

---

## Phase 16 — Policy, Preflight, and Authorization Classification

**STATUS: OWNER ACTION REQUIRED FOR CANONICAL PASS; DETERMINISTIC POLICY ENGINE IMPLEMENTED**

Implemented exact dispositions:
- AUTO
- APPROVAL_REQUIRED
- STRONG_APPROVAL
- BLOCKED

Deterministic evaluation includes:
- authenticated identity presence;
- server-resolved scope presence;
- known/enabled capability;
- capability approval class;
- environment eligibility;
- data-class eligibility;
- region eligibility;
- credential-binding availability;
- protected capacity/headroom;
- fallback requirement;
- idempotency requirement;
- applicable kill switches;
- budget hard limits;
- budget approval thresholds;
- protected/non-protected guardrails;
- approval state;
- fresh step-up requirement for strong approval.

BLOCKED always outranks approval. A fresh step-up can satisfy a strong approval requirement but never converts blocked work into allowed work.

Deferred:
- real production session/step-up provider;
- persistent Decision/Approval records wired to this evaluator;
- secure mobile decision deep links;
- production database-backed policy resolution.

---

## Phase 17 — Autonomous Task Generation

**STATUS: OWNER ACTION REQUIRED FOR CANONICAL PASS; DETERMINISTIC GENERATOR IMPLEMENTED**

Implemented:
- task generation only from deterministically valid and authorization-ready plan steps;
- paused/completed objective suppression;
- immutable portfolio/company/environment/data scope;
- immutable reason/evidence;
- deterministic priority;
- capability requirements;
- capability operation inputs;
- authorization lineage;
- plan-step dependency lineage;
- preconditions;
- verification requirements;
- rollback semantics;
- future resource requirement envelope;
- estimated cost;
- atomic logical-dedupe store contract.

Logical task keys use:
- authoritative portfolio/company;
- source type/reference;
- a SHA-256 semantic fingerprint of requested work.

This allows equivalent work regenerated under a different plan ID from the same source to deduplicate rather than create a second logical task.

Deferred:
- durable database implementation of the dedupe contract;
- queueing/dispatch;
- worker claims;
- resource placement.

---

## Phase 18 — Task Compiler and Executable DAG

**STATUS: DETERMINISTIC SUBSET PASS**

Implemented:
- task dependency validation;
- cycle detection;
- deterministic topological ordering;
- same-scope enforcement across compiled tasks;
- typed capability lookup;
- capability input revalidation at compile time;
- provider/adapter binding resolution from the capability registry;
- capability output validation contract;
- preconditions;
- explicit verification nodes;
- explicit rollback nodes;
- cancellation semantics;
- task dependency through upstream verification nodes;
- future resource requirement envelopes;
- explicit `resourceSelection: "deferred"`.

The compiler does not choose hardware. Resource requirements remain requirements such as:
- CPU/RAM/GPU/VRAM;
- architecture;
- environment;
- deadline/priority/duration;
- checkpointability/retryability;
- reliability tier;
- interruption class;
- data classification;
- allowed regions/locality;
- max job cost;
- fallback requirement.

Hard-coded resource IDs are not part of the resource requirement schema.

Deferred:
- no durable dispatch;
- no queue/lease/heartbeat behavior;
- no resource placement;
- no scheduler;
- no action adapter execution.

---

## Verification

Repository tests cover:
- plan-schema completeness;
- server-authorized plan scope/source;
- unsupported capability detection;
- malformed capability input;
- dependency cycles/unknown dependencies;
- contradictory plan steps;
- cost ceilings;
- environment/data/reliability/fallback rules;
- high-risk rollback owner decisions;
- AUTO / APPROVAL_REQUIRED / STRONG_APPROVAL / BLOCKED policy behavior;
- kill-switch precedence;
- budget and guardrail policy;
- strong-approval step-up;
- paused-objective task suppression;
- immutable task fields;
- semantic logical deduplication across regenerated plan IDs;
- authorization lineage;
- DAG dependency order;
- typed capability mapping;
- verification and rollback nodes;
- invalid capability/input rejection at compile time;
- unsatisfied dependencies;
- DAG cycles;
- resource-requirement preservation without resource selection.

## Resulting deterministic pipeline

```text
authorized objective / investigation / owner request
              |
              v
       structured proposal
              |
              v
      PlanProposalSchema
              |
              v
 server scope/source binding
              |
              v
       deterministic validator
              |
              v
        deterministic policy
 AUTO / APPROVAL / STRONG / BLOCKED
              |
              v
     immutable task generation
       + logical deduplication
              |
              v
       executable DAG compiler
 capability nodes -> verification nodes
       rollback paths modeled
              |
              v
       DURABLE DISPATCH DEFERRED
       RESOURCE SELECTION DEFERRED
```

The next heavy boundary remains production AI Gateway integration and later durable execution infrastructure. Those systems should consume these contracts rather than replace them.
