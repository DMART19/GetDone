import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type {
  AuthorizedBusinessActionRequest,
  BusinessActionExecutionContext
} from "@/lib/execution/adapters/business-action";
import {
  CalendarSchedulingAdapter,
  readCalendarProviderConfigurationsFromEnv
} from "@/lib/execution/adapters/calendar-scheduling";

const scope={
  userId:"owner",
  portfolioId:"portfolio-a",
  companyId:"company-a",
  environment:"production" as const
};

const configuration={
  id:"calendar-primary",
  companyId:"company-a",
  environment:"production" as const,
  credentialProviderId:"calendar-provider",
  baseUrl:"https://calendar.example.test/v1/",
  calendarPath:"calendars/{calendarId}/events",
  eventPath:"calendars/{calendarId}/events/{eventId}",
  conflictCheckPath:"calendars/{calendarId}/conflicts",
  readScopes:["calendar.read"],
  writeScopes:["calendar.write","calendar.read"]
};

function request(capability:string,input:unknown):AuthorizedBusinessActionRequest{
  return {
    id:`request-${capability}`,
    jobId:`job-${capability}`,
    scope,
    capability,
    input,
    inputHash:sha256Hex(input),
    authorizationConsumptionHash:`consumption-${capability}`,
    credentialLeaseId:`lease-${capability}`,
    idempotencyKey:`idem-${capability}`,
    timeoutMs:5_000,
    attempt:1
  };
}

function context(capability:string,scopes=configuration.writeScopes):BusinessActionExecutionContext{
  return {
    credential:{
      leaseId:`lease-${capability}`,
      leaseHash:sha256Hex({capability}),
      providerId:"calendar-provider",
      capability,
      grantedScopes:[...scopes],
      material:"short-lived-calendar-token",
      issuedAt:"2026-09-25T20:00:00Z",
      expiresAt:"2099-01-01T00:00:00Z"
    }
  };
}

function providerEvent(input:{
  id:string;
  summary?:string;
  start?:string;
  end?:string;
  zone?:string;
  status?:string;
  etag?:string;
}){
  return {
    id:input.id,
    etag:input.etag??'"v1"',
    status:input.status??"confirmed",
    summary:input.summary??"Meeting",
    start:{
      dateTime:input.start??"2026-10-01T17:00:00Z",
      timeZone:input.zone??"America/Los_Angeles"
    },
    end:{
      dateTime:input.end??"2026-10-01T18:00:00Z",
      timeZone:input.zone??"America/Los_Angeles"
    },
    attendees:[{email:"A@EXAMPLE.COM"}]
  };
}

describe("calendar scheduling adapter",()=>{
  it("reads events with UTC-normalized instants while preserving IANA timezone",async()=>{
    const adapter=new CalendarSchedulingAdapter([configuration],{
      fetchImpl:async()=>new Response(JSON.stringify(providerEvent({
        id:"evt-1",
        start:"2026-10-01T10:00:00-07:00",
        end:"2026-10-01T11:00:00-07:00"
      })),{status:200}),
      now:()=>new Date("2026-09-25T20:00:00Z")
    });
    const result=await adapter.execute(request("calendar.event.read",{
      companyId:"company-a",
      connectionId:"calendar-primary",
      calendarId:"primary",
      eventId:"evt-1"
    }),context("calendar.event.read",configuration.readScopes));
    expect(result).toMatchObject({
      status:"completed",
      jobStateMutationApplied:false,
      output:{
        calendarId:"primary",
        eventId:"evt-1",
        startAt:"2026-10-01T17:00:00.000Z",
        endAt:"2026-10-01T18:00:00.000Z",
        timeZone:"America/Los_Angeles",
        attendees:["a@example.com"]
      }
    });
  });

  it("creates with deterministic identity, conflict check, and follow-up verification",async()=>{
    let createdId="";
    const calls:{method:string;url:string;body?:unknown}[]=[];
    const adapter=new CalendarSchedulingAdapter([configuration],{
      now:()=>new Date("2026-09-25T20:00:00Z"),
      fetchImpl:async(url,init)=>{
        const method=init?.method??"GET";
        const value=String(url);
        const body=init?.body?JSON.parse(String(init.body)):undefined;
        calls.push({method,url:value,body});
        if(value.endsWith("/conflicts")){
          return new Response('{"conflict":false}',{status:200});
        }
        if(method==="POST"){
          createdId=(body as {id:string}).id;
          return new Response(JSON.stringify(providerEvent({
            id:createdId,
            summary:"Planning"
          })),{status:201});
        }
        return new Response(JSON.stringify(providerEvent({
          id:createdId,
          summary:"Planning"
        })),{status:200});
      }
    });
    const input={
      companyId:"company-a",
      connectionId:"calendar-primary",
      calendarId:"primary",
      title:"Planning",
      startAt:"2026-10-01T10:00:00-07:00",
      endAt:"2026-10-01T11:00:00-07:00",
      timeZone:"America/Los_Angeles",
      attendees:["a@example.com"],
      conflictPolicy:"reject" as const
    };
    const req=request("calendar.event.create",input);
    const ctx=context("calendar.event.create");
    const accepted=await adapter.execute(req,ctx);
    expect(createdId).toMatch(/^gd-[a-f0-9]{40}$/);
    expect(accepted).toMatchObject({
      status:"accepted",
      output:{
        eventId:createdId,
        providerAccepted:true,
        conflictChecked:true
      },
      jobStateMutationApplied:false
    });
    await expect(adapter.status({
      requestId:req.id,
      providerOperationId:accepted.providerOperationId!
    },ctx)).resolves.toMatchObject({
      state:"completed",
      jobStateMutationApplied:false
    });
    expect(calls[0]?.url).toContain("/conflicts");
  });

  it("treats deterministic create 409 as idempotent only when the existing event matches",async()=>{
    let createdId="";
    const adapter=new CalendarSchedulingAdapter([configuration],{
      fetchImpl:async(_url,init)=>{
        if(init?.method==="POST"){
          const body=JSON.parse(String(init.body)) as {id:string};
          createdId=body.id;
          return new Response('{"error":"exists"}',{status:409});
        }
        return new Response(JSON.stringify(providerEvent({
          id:createdId,
          summary:"Planning"
        })),{status:200});
      }
    });
    const input={
      companyId:"company-a",
      connectionId:"calendar-primary",
      calendarId:"primary",
      title:"Planning",
      startAt:"2026-10-01T10:00:00-07:00",
      endAt:"2026-10-01T11:00:00-07:00",
      timeZone:"America/Los_Angeles",
      attendees:["a@example.com"],
      conflictPolicy:"allow" as const
    };
    await expect(adapter.execute(
      request("calendar.event.create",input),
      context("calendar.event.create")
    )).resolves.toMatchObject({status:"accepted"});
  });

  it("rejects stale update versions and verifies successful updates by follow-up read",async()=>{
    let updated=false;
    const adapter=new CalendarSchedulingAdapter([configuration],{
      fetchImpl:async(_url,init)=>{
        if(init?.method==="POST") return new Response('{"conflict":false}',{status:200});
        if(init?.method==="PATCH"){
          expect((init.headers as Record<string,string>)["if-match"]).toBe('"v1"');
          updated=true;
          return new Response(JSON.stringify(providerEvent({
            id:"evt-2",summary:"Updated",etag:'"v2"'
          })),{status:200});
        }
        return new Response(JSON.stringify(providerEvent({
          id:"evt-2",summary:updated?"Updated":"Old",etag:updated?'"v2"':'"v1"'
        })),{status:200});
      }
    });
    const input={
      companyId:"company-a",
      connectionId:"calendar-primary",
      calendarId:"primary",
      eventId:"evt-2",
      expectedVersion:'"v1"',
      title:"Updated",
      startAt:"2026-10-01T10:00:00-07:00",
      endAt:"2026-10-01T11:00:00-07:00",
      timeZone:"America/Los_Angeles",
      attendees:["a@example.com"],
      conflictPolicy:"reject" as const
    };
    const req=request("calendar.event.update",input);
    const ctx=context("calendar.event.update");
    const accepted=await adapter.execute(req,ctx);
    expect(accepted.status).toBe("accepted");
    await expect(adapter.status({
      requestId:req.id,
      providerOperationId:accepted.providerOperationId!
    },ctx)).resolves.toMatchObject({state:"completed"});

    const stale=new CalendarSchedulingAdapter([configuration],{
      fetchImpl:async(_url,init)=>init?.method==="POST"
        ? new Response('{"conflict":false}',{status:200})
        : new Response('{"error":"precondition"}',{status:412})
    });
    await expect(stale.execute(
      request("calendar.event.update",input),
      ctx
    )).resolves.toMatchObject({
      status:"rejected",
      retryable:false,
      retryClass:"provider-4xx",
      output:{conflict:true}
    });
  });

  it("cancels with version precondition and accepts provider deletion as verified completion",async()=>{
    let deleted=false;
    const adapter=new CalendarSchedulingAdapter([configuration],{
      fetchImpl:async(_url,init)=>{
        if(init?.method==="DELETE"){
          expect((init.headers as Record<string,string>)["if-match"]).toBe('"v9"');
          deleted=true;
          return new Response(null,{status:204});
        }
        return deleted
          ? new Response('{"error":"missing"}',{status:404})
          : new Response(JSON.stringify(providerEvent({id:"evt-9",etag:'"v9"'})),{status:200});
      }
    });
    const req=request("calendar.event.cancel",{
      companyId:"company-a",
      connectionId:"calendar-primary",
      calendarId:"primary",
      eventId:"evt-9",
      expectedVersion:'"v9"',
      reason:"No longer needed"
    });
    const ctx=context("calendar.event.cancel");
    const accepted=await adapter.execute(req,ctx);
    expect(accepted.status).toBe("accepted");
    await expect(adapter.status({
      requestId:req.id,
      providerOperationId:accepted.providerOperationId!
    },ctx)).resolves.toMatchObject({state:"completed"});
  });

  it("fails closed on invalid timezones, provider conflicts, tenant drift, and unsafe config",async()=>{
    const adapter=new CalendarSchedulingAdapter([configuration],{
      fetchImpl:async(url)=>String(url).endsWith("/conflicts")
        ? new Response('{"conflict":true}',{status:200})
        : new Response("{}",{status:200})
    });
    const badZone={
      companyId:"company-a",connectionId:"calendar-primary",calendarId:"primary",
      title:"Meeting",startAt:"2026-10-01T10:00:00-07:00",
      endAt:"2026-10-01T11:00:00-07:00",timeZone:"Mars/Olympus",
      attendees:[],conflictPolicy:"reject" as const
    };
    await expect(adapter.execute(
      request("calendar.event.create",badZone),
      context("calendar.event.create")
    )).rejects.toMatchObject({code:"VALIDATION_FAILED"});

    const conflict={...badZone,timeZone:"America/Los_Angeles"};
    await expect(adapter.execute(
      request("calendar.event.create",conflict),
      context("calendar.event.create")
    )).rejects.toMatchObject({code:"CONFLICT"});

    const tenant=request("calendar.event.read",{
      companyId:"company-a",connectionId:"calendar-primary",calendarId:"primary",eventId:"evt"
    });
    tenant.scope={...scope,companyId:"company-b"};
    await expect(adapter.execute(
      tenant,
      context("calendar.event.read",configuration.readScopes)
    )).rejects.toMatchObject({code:"POLICY_BLOCKED"});

    expect(()=>new CalendarSchedulingAdapter([{
      ...configuration,
      baseUrl:"http://calendar.example.test/"
    }])).toThrow(/HTTPS/i);
  });

  it("parses strict server-only calendar configuration",()=>{
    const env={GETDONE_CALENDAR_ACTIONS_JSON:JSON.stringify([configuration])};
    expect(readCalendarProviderConfigurationsFromEnv(env)).toHaveLength(1);
    expect(()=>readCalendarProviderConfigurationsFromEnv({
      GETDONE_CALENDAR_ACTIONS_JSON:JSON.stringify([{...configuration,rawToken:"secret"}])
    })).toThrow();
  });
});
