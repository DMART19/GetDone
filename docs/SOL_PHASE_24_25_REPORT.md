# Sol Phase 24 / 25 Deterministic Foundation Report

This report records the GPT-5.6 Sol Phase 24/25 tranche. It documents deterministic repository and client-runtime work only. It does not claim production infrastructure acceptance where the master build plan requires real providers, persistence, durable workers, hardware, or external security evidence.

## Phase 24 — Portfolio Intelligence and Security Hardening

Implemented:
- company-attributed portfolio executive summaries;
- explicit authorized-company scope and cross-portfolio filtering;
- fresh-snapshot selection without losing company attribution;
- external authority boundary for AI/model/gateway/provider/callback/frontend/resource-agent inputs;
- rejection of protected authority fields embedded in untrusted payloads;
- production-promotion gate requiring control-plane authority, authentication, trusted scope, policy, verified approval, fresh deployment verification, deployment reference, and rollback reference;
- automated adversarial regression suite covering auth expiry, tenancy escalation, callback forgery, credential-scope leakage, prompt/context contamination, external authority forgery, provider kill switches, and production promotion;
- Resource Fabric future-threat tests for impersonation, fake enrollment readiness, forged heartbeat, capacity spoofing, reservation replay, and scheduler bypass.

The security layer treats external claims as evidence/proposals only. They do not establish authoritative state.

Still deferred:
- real database/RLS penetration tests;
- live AI Gateway/provider red-team execution;
- production secrets/credential-provider tests;
- external penetration testing;
- real deployment executor.

## Phase 25 — PWA Packaging, Push, and Mobile Delivery

Implemented:
- standalone PWA manifest with explicit app id/scope/orientation;
- iPhone web-app metadata;
- service-worker registration;
- service-worker update-available event;
- reconnect event for authoritative state re-fetch;
- network-first navigation with offline fallback;
- shell cache restricted to `/offline` and `/icon.svg`;
- explicit rule that `/api/*` and authenticated application state are not cached;
- generic/redacted push notification presentation in the service worker;
- notification-click routing through safe internal destinations;
- typed deep-link builders for Decision, Task/Result, Resource, Resource Incident, and Resource Decision;
- deterministic notification routing:
  - FYI -> non-push result/history path;
  - Normal -> non-push decision path;
  - High/Critical -> push-eligible;
- sensitive/high-attention lock-screen redaction;
- update deferral while offline, with unsaved owner input, or during strong approval;
- deterministic WebAuthn ceremony validation for expiry, RP ID, origin, credential identity, and user verification;
- baseline response headers plus no-cache/service-worker scope headers.

Still deferred:
- production push subscription and delivery service;
- delivery receipts;
- real auth provider WebAuthn cryptographic verification;
- secure production session persistence;
- durable cloud runtime needed for phone-off continuity acceptance;
- native Watch companion.

## Authority preservation

Phase 25 does not give the browser, service worker, notification, or deep link any approval or execution authority. Mobile surfaces navigate the owner to server-authoritative state and require the existing control-plane policy/approval paths for consequential action.

## Canonical PASS boundary

These deterministic/client-runtime implementations reduce the remaining integration surface, but canonical Phase 24/25 PASS still requires the infrastructure-dependent evidence identified above and the master build plan acceptance criteria.
