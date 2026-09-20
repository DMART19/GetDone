# UFO v2 Visual Acceptance

The supplied UFO v2 screenshot is the visual source of truth for the owner-facing shell.

## Permanent owner navigation

- Chat
- Decisions
- Resources
- No fourth permanent bottom-nav destination

## Home / Chat

- [ ] Near-black / deep navy background
- [ ] Compact GetDone header centered between menu and avatar
- [ ] Centered “How can I move things forward today?” headline
- [ ] Five compact executive quick actions
- [ ] “Check my resources” carries the NEW treatment
- [ ] Compact message composer with circular blue send control
- [ ] Bottom navigation remains visible and keyboard-safe

## Resources

- [ ] Resources title + NEW
- [ ] Exact subtitle intent from screenshot
- [ ] 2x2 summary grid: Health, Total Capacity, Monthly Spend, Savings (Owned)
- [ ] All / Compute / Storage / Network filters
- [ ] Compact resource rows with name, type/role, health
- [ ] Full-width + Add Resource action
- [ ] No admin-console telemetry on overview

## Add Resource

- [ ] Back + centered title + Cancel
- [ ] Compute
- [ ] Storage
- [ ] Network
- [ ] Cloud Provider
- [ ] Data Center / Partner
- [ ] Other
- [ ] Plain-language “Not sure?” path
- [ ] No permanent bottom nav on this setup screen

## Decisions

- [ ] Single approval inbox
- [ ] High / Normal / FYI filtering
- [ ] Colored severity rails
- [ ] Compact card icon + title + subtitle + priority + age + chevron
- [ ] Resource decisions live in the same queue as business decisions

## Resource Detail

Visual order must remain:

1. Resource identity + health
2. Actions
3. Overview / Usage / Cost / Health tabs
4. Three key metrics
5. Location / Provider / Environments / Customer Data / Reliability Tier / Auto-scheduling
6. View Capabilities
7. Current Workloads

## Mobile requirements

- [ ] 320px width: no horizontal page overflow
- [ ] 360px width: no horizontal page overflow
- [ ] 375px width: no horizontal page overflow
- [ ] 390px width: no horizontal page overflow
- [ ] 393px width: no horizontal page overflow
- [ ] 430px width: no horizontal page overflow
- [ ] Safe-area insets respected
- [ ] Reduced-motion preference respected
- [ ] Visible keyboard does not cover the composer

## Development truthfulness

- [ ] Seeded data is marked DEV without materially changing the screenshot layout
- [ ] Preview buttons never claim production side effects
- [ ] Resource state is not represented as real telemetry until connected to authoritative backend data
