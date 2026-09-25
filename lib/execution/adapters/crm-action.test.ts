import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type {
  AuthorizedBusinessActionRequest,
  BusinessActionExecutionContext
} from "@/lib/execution/adapters/business-action";
import {
  CrmBusinessActionAdapter,
  readCrmProviderConfigurationsFromEnv
} from "@/lib/execution/adapters/crm-action";
import { createOrdinaryBusinessActionBindingsFromEnv } from "@/lib/execution/adapters/ordinary-integration-registry";

const scope={
  userId:"owner",
  portfolioId:"portfolio-a",
  companyId:"company-a",
  environment:"production" as const
};

const configuration={
  id:"crm-primary",
  companyId:"company-a",
  environment:"production" as const,
  credentialProviderId:"crm-provider",
  baseUrl:"https://crm.example.test/api/",
  objects:{
    contact:{collectionPath:"contacts",itemPath:"contacts/{recordId}"},
    company:{collectionPath:"companies",itemPath:"companies/{recordId}"},
    deal:{collectionPath:"deals",itemPath:"deals/{recordId}"}
  },
  readScopes:["crm.objects.read"],
  writeScopes:["crm.objects.write"]
};

function action(
  capability:"crm.record.read"|"crm.record.write",
  input:unknown
):AuthorizedBusinessActionRequest{
  return {
    id:`action-${capability}`,
    jobId:`job-${capability}`,
    scope,
    capability,
    input,
    inputHash:sha256Hex(input),
    authorizationConsumptionHash:"consumption-crm",
    credentialLeaseId:"lease-crm",
    idempotencyKey:"idem-crm",
    timeoutMs:5_000,
    attempt:1
  };
}

function context(
  capability:"crm.record.read"|"crm.record.write",
  scopes:readonly string[]
):BusinessActionExecutionContext{
  return {
    credential:{
      leaseId:"lease-crm",
      leaseHash:sha256Hex({capability}),
      providerId:"crm-provider",
      capability,
      grantedScopes:[...scopes],
      material:"short-lived-crm-token",
      issuedAt:"2026-09-25T19:00:00Z",
      expiresAt:"2099-01-01T00:00:00Z"
    }
  };
}

describe("generic CRM business adapter",()=>{
  it("reads contacts, companies, and deals as bounded non-mutating results",async()=>{
    const calls:string[]=[];
    const adapter=new CrmBusinessActionAdapter([configuration],{
      fetchImpl:async(url,init)=>{
        calls.push(`${init?.method??"GET"} ${String(url)}`);
        const id=String(url).split("/").at(-1)!;
        return new Response(JSON.stringify({
          id,
          properties:{name:"Acme",active:true}
        }),{status:200});
      },
      now:()=>new Date("2026-09-25T20:00:00Z")
    });
    for(const objectType of ["contact","company","deal"] as const){
      const input={
        companyId:"company-a",
        connectionId:"crm-primary",
        objectType,
        recordId:`${objectType}-1`
      };
      const result=await adapter.execute(
        action("crm.record.read",input),
        context("crm.record.read",["crm.objects.read"])
      );
      expect(result).toMatchObject({
        status:"completed",
        output:{
          objectType,
          recordId:`${objectType}-1`,
          properties:{name:"Acme",active:true}
        },
        jobStateMutationApplied:false
      });
    }
    expect(calls).toEqual([
      "GET https://crm.example.test/api/contacts/contact-1",
      "GET https://crm.example.test/api/companies/company-1",
      "GET https://crm.example.test/api/deals/deal-1"
    ]);
  });

  it("keeps create provider acceptance non-authoritative until a follow-up read matches",async()=>{
    const calls:string[]=[];
    const adapter=new CrmBusinessActionAdapter([configuration],{
      fetchImpl:async(url,init)=>{
        calls.push(`${init?.method??"GET"} ${String(url)}`);
        if(init?.method==="POST"){
          expect((init.headers as Record<string,string>)["idempotency-key"]).toBe("idem-crm");
          return new Response(JSON.stringify({
            id:"contact-42",
            properties:{email:"owner@example.com",stage:"lead"}
          }),{status:201});
        }
        return new Response(JSON.stringify({
          id:"contact-42",
          properties:{email:"owner@example.com",stage:"lead",providerAdded:"ignored"}
        }),{status:200});
      },
      now:()=>new Date("2026-09-25T20:00:00Z")
    });
    const input={
      companyId:"company-a",
      connectionId:"crm-primary",
      objectType:"contact" as const,
      operation:"create" as const,
      properties:{email:"owner@example.com",stage:"lead"}
    };
    const writeContext=context("crm.record.write",[
      "crm.objects.write","crm.objects.read"
    ]);
    const accepted=await adapter.execute(action("crm.record.write",input),writeContext);
    expect(accepted).toMatchObject({
      status:"accepted",
      output:{recordId:"contact-42",providerAccepted:true},
      jobStateMutationApplied:false
    });
    expect(accepted.providerOperationId).toMatch(/^crm:crm-primary:contact:/);

    const verified=await adapter.status({
      requestId:accepted.requestId,
      providerOperationId:accepted.providerOperationId!
    },writeContext);
    expect(verified).toMatchObject({state:"completed",jobStateMutationApplied:false});
    expect(calls).toHaveLength(2);
  });

  it("requires a matching follow-up read for updates and never treats acceptance as completion",async()=>{
    let readMatches=false;
    const adapter=new CrmBusinessActionAdapter([configuration],{
      fetchImpl:async(_url,init)=>{
        if(init?.method==="PATCH"){
          return new Response(JSON.stringify({id:"deal-9"}),{status:200});
        }
        return new Response(JSON.stringify({
          id:"deal-9",
          properties:{stage:readMatches?"closedwon":"negotiation",amount:125000}
        }),{status:200});
      }
    });
    const input={
      companyId:"company-a",
      connectionId:"crm-primary",
      objectType:"deal" as const,
      operation:"update" as const,
      recordId:"deal-9",
      properties:{stage:"closedwon",amount:125000}
    };
    const writeContext=context("crm.record.write",[
      "crm.objects.write","crm.objects.read"
    ]);
    const accepted=await adapter.execute(action("crm.record.write",input),writeContext);
    expect(accepted.status).toBe("accepted");
    await expect(adapter.status({
      requestId:accepted.requestId,
      providerOperationId:accepted.providerOperationId!
    },writeContext)).resolves.toMatchObject({state:"running"});

    readMatches=true;
    await expect(adapter.status({
      requestId:accepted.requestId,
      providerOperationId:accepted.providerOperationId!
    },writeContext)).resolves.toMatchObject({state:"completed"});
  });

  it("fails closed on tenant drift, missing verification scope, malformed responses and unsafe config",async()=>{
    const adapter=new CrmBusinessActionAdapter([configuration],{
      fetchImpl:async()=>new Response('{"properties":{}}',{status:200})
    });
    const createInput={
      companyId:"company-a",
      connectionId:"crm-primary",
      objectType:"company" as const,
      operation:"create" as const,
      properties:{name:"Acme"}
    };
    await expect(adapter.execute(
      action("crm.record.write",createInput),
      context("crm.record.write",["crm.objects.write"])
    )).rejects.toThrow(/broker/i);

    const wrongScope=action("crm.record.write",createInput);
    wrongScope.scope={...scope,companyId:"company-b"};
    await expect(adapter.execute(
      wrongScope,
      context("crm.record.write",["crm.objects.write","crm.objects.read"])
    )).rejects.toThrow(/outside/i);

    await expect(adapter.execute(
      action("crm.record.write",createInput),
      context("crm.record.write",["crm.objects.write","crm.objects.read"])
    )).resolves.toMatchObject({status:"failed",retryClass:"malformed-response"});

    expect(()=>new CrmBusinessActionAdapter([{
      ...configuration,
      baseUrl:"http://crm.example.test/",
    }])).toThrow(/HTTPS/i);
    expect(()=>new CrmBusinessActionAdapter([{
      ...configuration,
      objects:{
        ...configuration.objects,
        contact:{collectionPath:"contacts",itemPath:"contacts/static"}
      }
    }])).toThrow(/recordId/i);
  });

  it("parses server-only CRM config and registers both CRM capabilities",()=>{
    const env={
      GETDONE_CRM_ACTIONS_JSON:JSON.stringify([configuration])
    };
    expect(readCrmProviderConfigurationsFromEnv(env)).toHaveLength(1);
    expect(createOrdinaryBusinessActionBindingsFromEnv(env).map((item)=>item.capability))
      .toEqual(["crm.record.read","crm.record.write"]);
    expect(()=>readCrmProviderConfigurationsFromEnv({
      GETDONE_CRM_ACTIONS_JSON:JSON.stringify([{
        ...configuration,
        rawToken:"secret"
      }])
    })).toThrow();
  });
});
