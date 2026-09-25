import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { getCapability } from "@/lib/domain/capabilities";
import type {
  AuthorizedBusinessActionRequest,
  BusinessActionExecutionContext
} from "@/lib/execution/adapters/business-action";
import {
  GithubStandardOperationAdapter,
  readGithubProviderConfigurationsFromEnv
} from "@/lib/execution/adapters/github-standard-operation";

const scope={
  userId:"owner",
  portfolioId:"portfolio-a",
  companyId:"company-a",
  environment:"production" as const
};

const configuration={
  id:"github-primary",
  companyId:"company-a",
  environment:"production" as const,
  credentialProviderId:"github-provider",
  apiBaseUrl:"https://api.github.test/",
  repositories:["DMART19/GetDone"],
  protectedBranches:["main"],
  readScopes:["contents:read","checks:read"],
  writeScopes:["contents:write","pull_requests:write","issues:write","contents:read"]
};

function action(capability:string,input:unknown):AuthorizedBusinessActionRequest{
  return {
    id:`action-${capability}`,
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
      providerId:"github-provider",
      capability,
      grantedScopes:[...scopes],
      material:"short-lived-github-token",
      issuedAt:"2026-09-25T20:00:00Z",
      expiresAt:"2099-01-01T00:00:00Z"
    }
  };
}

describe("GitHub standard-operation adapter",()=>{
  it("keeps merge and protected-branch writes behind strong approval",()=>{
    expect(getCapability("github.pull-request.merge")).toMatchObject({
      approval:"strong-approval",
      risk:"critical"
    });
    expect(getCapability("github.protected-branch.commit")).toMatchObject({
      approval:"strong-approval",
      risk:"critical"
    });
    expect(getCapability("github.commit.create")?.approval).toBe("approval");
    expect(getCapability("github.repository.read")?.approval).toBe("auto");
  });

  it("performs bounded governed repository and checks/status reads",async()=>{
    const calls:string[]=[];
    const adapter=new GithubStandardOperationAdapter([configuration],{
      fetchImpl:async(url)=>{
        calls.push(String(url));
        if(String(url).includes("/check-runs")){
          return new Response(JSON.stringify({total_count:1,check_runs:[{name:"CI",conclusion:"success"}]}),{status:200});
        }
        if(String(url).endsWith("/status")){
          return new Response(JSON.stringify({state:"success",statuses:[]}),{status:200});
        }
        return new Response(JSON.stringify({full_name:"DMART19/GetDone",private:false}),{status:200});
      },
      now:()=>new Date("2026-09-25T20:00:00Z")
    });
    const read=action("github.repository.read",{
      companyId:"company-a",connectionId:"github-primary",
      repository:"DMART19/GetDone",operation:"repository"
    });
    await expect(adapter.execute(
      read,
      context("github.repository.read",configuration.readScopes)
    )).resolves.toMatchObject({
      status:"completed",
      output:{repository:"DMART19/GetDone",operation:"repository"}
    });

    const checks=action("github.repository.read",{
      companyId:"company-a",connectionId:"github-primary",
      repository:"DMART19/GetDone",operation:"checks",ref:"abc1234"
    });
    await expect(adapter.execute(
      checks,
      context("github.repository.read",configuration.readScopes)
    )).resolves.toMatchObject({
      status:"completed",
      output:{repository:"DMART19/GetDone",operation:"checks"}
    });
    expect(calls.some((value)=>value.includes("/check-runs"))).toBe(true);
    expect(calls.some((value)=>value.endsWith("/status"))).toBe(true);
  });

  it("creates and verifies a branch without treating provider acceptance as Job truth",async()=>{
    let verification=false;
    const adapter=new GithubStandardOperationAdapter([configuration],{
      fetchImpl:async(url,init)=>{
        const value=String(url);
        if(init?.method==="POST"){
          return new Response(JSON.stringify({ref:"refs/heads/feature-a",object:{sha:"a".repeat(40)}}),{status:201});
        }
        if(value.includes("/git/ref/heads/feature-a") && verification){
          return new Response(JSON.stringify({ref:"refs/heads/feature-a",object:{sha:"a".repeat(40)}}),{status:200});
        }
        return new Response(JSON.stringify({ref:"refs/heads/main",object:{sha:"a".repeat(40)}}),{status:200});
      }
    });
    const request=action("github.branch.create",{
      companyId:"company-a",connectionId:"github-primary",repository:"DMART19/GetDone",
      branch:"feature-a",fromRef:"main"
    });
    const ctx=context("github.branch.create");
    const accepted=await adapter.execute(request,ctx);
    expect(accepted).toMatchObject({
      status:"accepted",
      jobStateMutationApplied:false,
      output:{operation:"branch.create",providerAccepted:true}
    });
    verification=true;
    await expect(adapter.status({
      requestId:request.id,
      providerOperationId:accepted.providerOperationId!
    },ctx)).resolves.toMatchObject({state:"completed",jobStateMutationApplied:false});
  });

  it("creates one Git commit from file changes and blocks ordinary writes to protected branches",async()=>{
    const calls:{url:string;method:string;body:unknown}[]=[];
    const adapter=new GithubStandardOperationAdapter([configuration],{
      fetchImpl:async(url,init)=>{
        const method=init?.method??"GET";
        const value=String(url);
        const body=init?.body?JSON.parse(String(init.body)):undefined;
        calls.push({url:value,method,body});
        if(value.includes("/git/ref/heads/feature-a")&&method==="GET"){
          return new Response(JSON.stringify({object:{sha:"1".repeat(40)}}),{status:200});
        }
        if(value.includes("/git/commits/")&&method==="GET"){
          return new Response(JSON.stringify({sha:"1".repeat(40),tree:{sha:"2".repeat(40)}}),{status:200});
        }
        if(value.endsWith("/git/blobs")){
          return new Response(JSON.stringify({sha:"3".repeat(40)}),{status:201});
        }
        if(value.endsWith("/git/trees")){
          return new Response(JSON.stringify({sha:"4".repeat(40)}),{status:201});
        }
        if(value.endsWith("/git/commits")){
          return new Response(JSON.stringify({sha:"5".repeat(40)}),{status:201});
        }
        if(value.includes("/git/refs/heads/feature-a")&&method==="PATCH"){
          return new Response(JSON.stringify({object:{sha:"5".repeat(40)}}),{status:200});
        }
        return new Response("{}",{status:404});
      }
    });
    const normal=action("github.commit.create",{
      companyId:"company-a",connectionId:"github-primary",repository:"DMART19/GetDone",
      branch:"feature-a",message:"Update files",
      files:[
        {path:"src/a.ts",operation:"upsert",content:"export const a=1;"},
        {path:"src/old.ts",operation:"delete"}
      ]
    });
    const accepted=await adapter.execute(normal,context("github.commit.create"));
    expect(accepted).toMatchObject({
      status:"accepted",
      output:{operation:"commit.create",providerReference:"5".repeat(40)}
    });
    expect(calls.filter((item)=>item.url.endsWith("/git/commits")&&item.method==="POST")).toHaveLength(1);
    expect(calls.some((item)=>item.method==="PATCH"&&item.body && (item.body as {force?:boolean}).force===false)).toBe(true);

    const protectedRequest=action("github.commit.create",{
      companyId:"company-a",connectionId:"github-primary",repository:"DMART19/GetDone",
      branch:"main",message:"Unsafe ordinary write",
      files:[{path:"README.md",operation:"upsert",content:"x"}]
    });
    await expect(adapter.execute(
      protectedRequest,
      context("github.commit.create")
    )).rejects.toMatchObject({code:"POLICY_BLOCKED"});
  });

  it("supports PR and issue create/update with follow-up read verification",async()=>{
    const adapter=new GithubStandardOperationAdapter([configuration],{
      fetchImpl:async(url,init)=>{
        const value=String(url);
        if(value.includes("/pulls")){
          return new Response(JSON.stringify({
            number:7,title:"Ship",body:"Ready",state:"open",draft:false,
            head:{ref:"feature-a"},base:{ref:"main"}
          }),{status:init?.method==="GET"?200:201});
        }
        return new Response(JSON.stringify({
          number:9,title:"Bug",body:"Fix",state:"open",labels:[{name:"bug"}]
        }),{status:init?.method==="GET"?200:201});
      }
    });

    const pr=action("github.pull-request.write",{
      companyId:"company-a",connectionId:"github-primary",repository:"DMART19/GetDone",
      operation:"create",title:"Ship",body:"Ready",head:"feature-a",base:"main"
    });
    const prCtx=context("github.pull-request.write");
    const prAccepted=await adapter.execute(pr,prCtx);
    expect(prAccepted.status).toBe("accepted");
    await expect(adapter.status({
      requestId:pr.id,providerOperationId:prAccepted.providerOperationId!
    },prCtx)).resolves.toMatchObject({state:"completed"});

    const issue=action("github.issue.write",{
      companyId:"company-a",connectionId:"github-primary",repository:"DMART19/GetDone",
      operation:"create",title:"Bug",body:"Fix",labels:["bug"]
    });
    const issueCtx=context("github.issue.write");
    const issueAccepted=await adapter.execute(issue,issueCtx);
    expect(issueAccepted.status).toBe("accepted");
    await expect(adapter.status({
      requestId:issue.id,providerOperationId:issueAccepted.providerOperationId!
    },issueCtx)).resolves.toMatchObject({state:"completed"});
  });

  it("merges only through the strong-approval capability and verifies merged state by read",async()=>{
    let merged=false;
    const adapter=new GithubStandardOperationAdapter([configuration],{
      fetchImpl:async(_url,init)=>{
        if(init?.method==="PUT"){
          merged=true;
          return new Response(JSON.stringify({merged:true,sha:"6".repeat(40)}),{status:200});
        }
        return new Response(JSON.stringify({
          number:4,merged,merge_commit_sha:merged?"6".repeat(40):null
        }),{status:200});
      }
    });
    const request=action("github.pull-request.merge",{
      companyId:"company-a",connectionId:"github-primary",repository:"DMART19/GetDone",
      number:4,method:"squash"
    });
    const ctx=context("github.pull-request.merge");
    const accepted=await adapter.execute(request,ctx);
    expect(accepted).toMatchObject({status:"accepted",jobStateMutationApplied:false});
    await expect(adapter.status({
      requestId:request.id,providerOperationId:accepted.providerOperationId!
    },ctx)).resolves.toMatchObject({state:"completed"});
  });

  it("parses server-only configuration and rejects repositories outside the allowlist",async()=>{
    const env={GETDONE_GITHUB_ACTIONS_JSON:JSON.stringify([configuration])};
    expect(readGithubProviderConfigurationsFromEnv(env)).toHaveLength(1);
    const adapter=new GithubStandardOperationAdapter([configuration],{
      fetchImpl:async()=>new Response("{}",{status:200})
    });
    const request=action("github.repository.read",{
      companyId:"company-a",connectionId:"github-primary",repository:"someone/else",
      operation:"repository"
    });
    await expect(adapter.execute(
      request,
      context("github.repository.read",configuration.readScopes)
    )).rejects.toMatchObject({code:"POLICY_BLOCKED"});
  });
});
