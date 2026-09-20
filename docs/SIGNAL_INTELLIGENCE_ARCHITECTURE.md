# Signal and Intelligence Architecture

## Authority flow

```text
Provider / Integration / Resource Callback
              |
              v
Authenticated Source Binding
              |
              v
       SignalBusService
   validate inbound envelope
   resolve trusted scope
              |
              v
SignalBusPersistence transaction
   dedupe claim
   normalized signal append
   stream cursor advancement
              |
              v
         Signal Store
              |
              v
        SensingEngine
 company/resource profile
 baseline + window + freshness
 deterministic classification
              |
      +-------+--------+
      |                |
 IGNORE/RECORD      MONITOR
      |                |
      +-------+--------+
              |
       INVESTIGATE /
         ESCALATE
              |
              v
 InvestigationCoordinator
 cooldown + active incident merge
              |
              v
       Context Assembler
 fresh + scoped + bounded evidence
              |
              v
      Future AI Gateway
  cognition only; no authority
```

## Trusted-scope rule

Incoming signal payloads do not carry authoritative `companyId`, `portfolioId`, or internal `resourceId`.

The server authenticates a source binding and resolves:
- portfolio
- company
- optional resource mapping

from server-owned configuration. Provider identifiers are only lookup hints.

## Atomic signal-ingestion rule

A durable implementation of `SignalBusPersistence` must treat these as one transaction:

1. logical-event dedupe claim
2. normalized signal append
3. stream cursor advancement

If normalized signal persistence fails, the dedupe claim must roll back so a provider retry can be accepted later.

## Out-of-order rule

A late unique event is not discarded merely because a newer event already exists.

It is stored with `outOfOrder: true`, but it does not move the stream cursor backward. Freshness and sensing logic determine whether it deserves attention.

## Cheap-first sensing rule

Signal ingestion performs no expensive reasoning.

The Sensing Engine first uses:
- resource signal rules
- configured company/resource baseline
- threshold ratios
- sample/window requirements
- sustained duration
- freshness
- cooldown

Only INVESTIGATE or ESCALATE conditions may create/update an Investigation. Future model reasoning can consume that bounded investigation context through the GetDone AI Gateway.

## External research rule

External research is advisory evidence only.

Limits apply before a request:
- requests per run
- cost per run
- requests per rolling window
- cost per rolling window

Provider failure returns a non-authoritative research failure and does not block core internal GetDone operations.

## Context rule

Context assembly filters before inclusion:

1. portfolio/company authorization
2. sensitivity
3. explicit resource authorization
4. freshness
5. per-section size
6. total item/character bounds

Every included item retains company attribution, source, provenance, observed time, and sensitivity. Context is evidence supplied to cognition, never authority.
