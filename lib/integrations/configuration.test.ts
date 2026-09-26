import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type {
  AuthorizedBusinessActionRequest,
  BusinessActionAdapter,
  BusinessActionExecutionContext
} from "@/lib/execution/adapters/business-action";
import { createBusinessActionAdapterResult, createBusinessActionStatus } from "@/lib/execution/adapters/business-action";
import { ManagedIntegrationBusinessActionAdapter } from "@/lib/execution/adapters/integration-config-gate";
import {
  INTEGRATION_PROVIDER_CATALOG,
  attachIntegrationVerification,
  createIntegrationConfiguration,
  transitionIntegrationConfiguration,
  updateIntegrationConfiguration,
  type IntegrationConfiguration,
  type IntegrationConfigurationStore
} from "@/lib/integrations/configuration";

const scope={
  userId:"owner",
  portfolioId:"portfolio-a",
  companyId:"company-a",
  environment:"production" as const
};

function create(overrides:Partial<Parameters<typeof createIntegrationConfiguration>[0]["value"]>={}){
  return createIntegrationConfiguration({
    scope,
    value:{
      id:"calendar-primary",
      provider:"calendar",
      displayName:"Production Calendar",
      capabilityNames:["calendar.event.read","calendar.event.create"],
      grantedScopes:["calendar.read","calendar.write"],
      credentialBindingId:"binding:calendar:prod",
      ...overrides
    },
    now:"2026-09-25T20:00:00Z"
  });
}

class MemoryStore implements IntegrationConfigurationStore {
  constructor(public record:IntegrationConfiguration|null){}
  async list(){return this.record?[this.record]:[];}
  async get(){return this.record;}
  async create(record:IntegrationConfiguration){this.record=record;return record;}
  async save(record:IntegrationConfiguration){this.record=record;return record;}
  async appendVerification(){return;}
}

class Delegate implements BusinessActionAdapter {
  readonly id="delegate";
  readonly version="1.0.0";
  calls=0;
  credentialRequirement(){return null;}
  async execute(request:AuthorizedBusinessActionRequest,_context?:BusinessActionExecutionContext){
    this.calls+=1;
    return createBusinessActionAdapterResult({
      source:"business-action-adapter",
      requestId:request.id,
      adapterId:this.id,
      adapterVersion:this.version,
      status:"completed",
      output:{ok:true},
      retryable:false,
      retryClass:"none",
      observedAt:"2026-09-25T20:00:00Z"
    });
  }
  async status(input:{requestId:string;providerOperationId:string}){
    return createBusinessActionStatus({
      source:"business-action-adapter",
      requestId:input.requestId,
      providerOperationId:input.providerOperationId,
      adapterId:this.id,
      adapterVersion:this.version,
      state:"completed",
      observedAt:"2026-09-25T20:00:00Z"
    });
  }
}

function request():AuthorizedBusinessActionRequest{
  const input={
    companyId:"company-a",
    connectionId:"calendar-primary",
    calendarId:"primary",
    eventId:"evt-1"
  };
  return {
    id:"request-calendar",
    jobId:"job-calendar",
    scope,
    capability:"calendar.event.read",
    input,
    inputHash:sha256Hex(input),
    authorizationConsumptionHash:"consumption-calendar",
    credentialLeaseId:"lease-calendar",
    idempotencyKey:"idem-calendar",
    timeoutMs:5_000,
    attempt:1
  };
}

describe("integration configuration domain",()=>{
  it("catalog exposes owner-safe provider capability/scopes without credentials",()=>{
    const calendar=INTEGRATION_PROVIDER_CATALOG.find((item)=>item.provider==="calendar");
    expect(calendar).toMatchObject({
      provider:"calendar",
      supportsCredentialBinding:true
    });
    expect(calendar?.capabilities).toEqual(expect.arrayContaining([
      "calendar.event.read","calendar.event.create","calendar.event.update","calendar.event.cancel"
    ]));
    expect(JSON.stringify(INTEGRATION_PROVIDER_CATALOG)).not.toMatch(/token|password|secret/i);
  });

  it("creates disabled broker-reference-only configuration and hashes it",()=>{
    const record=create();
    expect(record).toMatchObject({
      status:"disabled",
      health:"unknown",
      credentialBindingId:"binding:calendar:prod",
      portfolioId:"portfolio-a",
      companyId:"company-a",
      environment:"production",
      version:1
    });
    expect(record.configurationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(record)).not.toContain("short-lived-calendar-token");
  });

  it("requires disable-before-edit and makes revoke terminal",()=>{
    const disabled=create();
    const active=transitionIntegrationConfiguration(disabled,{
      action:"enable",at:"2026-09-25T20:01:00Z"
    });
    expect(active.status).toBe("active");
    expect(()=>updateIntegrationConfiguration(active,{
      displayName:"Changed",at:"2026-09-25T20:02:00Z"
    })).toThrow(/disabled before/i);

    const disabledAgain=transitionIntegrationConfiguration(active,{
      action:"disable",at:"2026-09-25T20:03:00Z"
    });
    const changed=updateIntegrationConfiguration(disabledAgain,{
      displayName:"Changed Calendar",
      credentialBindingId:"binding:calendar:v2",
      at:"2026-09-25T20:04:00Z"
    });
    expect(changed).toMatchObject({
      displayName:"Changed Calendar",
      credentialBindingId:"binding:calendar:v2",
      status:"disabled"
    });
    const revoked=transitionIntegrationConfiguration(changed,{
      action:"revoke",at:"2026-09-25T20:05:00Z"
    });
    expect(revoked.status).toBe("revoked");
    expect(()=>transitionIntegrationConfiguration(revoked,{
      action:"enable",at:"2026-09-25T20:06:00Z"
    })).toThrow(/Revoked/i);
  });

  it("will not enable without broker binding and rejects provider capability drift",()=>{
    const pending=createIntegrationConfiguration({
      scope,
      value:{
        id:"calendar-pending",
        provider:"calendar",
        displayName:"Pending",
        capabilityNames:["calendar.event.read"],
        grantedScopes:["calendar.read"]
      },
      now:"2026-09-25T20:00:00Z"
    });
    expect(pending.status).toBe("pending");
    expect(()=>transitionIntegrationConfiguration(pending,{
      action:"enable",at:"2026-09-25T20:01:00Z"
    })).toThrow(/credential binding/i);
    expect(()=>create({
      capabilityNames:["github.repository.read"]
    })).toThrow(/not allowed/i);
  });

  it("attaches hash-bound verification health evidence",()=>{
    const record=create();
    const verified=attachIntegrationVerification(record,{
      id:"verification-1",
      health:"healthy",
      verifiedAt:"2026-09-25T20:10:00Z",
      evidenceHash:"f".repeat(64),
      capabilityResults:{
        "calendar.event.read":"passed",
        "calendar.event.create":"passed"
      }
    });
    expect(verified).toMatchObject({
      health:"healthy",
      lastVerification:{
        id:"verification-1",
        health:"healthy"
      },
      version:2
    });
  });
});

describe("managed integration execution gate",()=>{
  it("blocks new actions while disabled but leaves status reconciliation available",async()=>{
    const store=new MemoryStore(create());
    const delegate=new Delegate();
    const managed=new ManagedIntegrationBusinessActionAdapter("calendar",delegate,store);
    await expect(managed.execute(request())).rejects.toMatchObject({code:"POLICY_BLOCKED"});
    expect(delegate.calls).toBe(0);

    await expect(managed.status({
      requestId:"request-calendar",
      providerOperationId:"operation-1"
    })).resolves.toMatchObject({state:"completed"});
  });

  it("allows only active managed capabilities and fails provider mismatch",async()=>{
    const active=transitionIntegrationConfiguration(create(),{
      action:"enable",at:"2026-09-25T20:01:00Z"
    });
    const store=new MemoryStore(active);
    const delegate=new Delegate();
    const managed=new ManagedIntegrationBusinessActionAdapter("calendar",delegate,store);
    await expect(managed.execute(request())).resolves.toMatchObject({status:"completed"});
    expect(delegate.calls).toBe(1);

    store.record={...active,provider:"github",configurationHash:"bad"} as IntegrationConfiguration;
    await expect(managed.execute(request())).rejects.toMatchObject({code:"POLICY_BLOCKED"});
  });
});
