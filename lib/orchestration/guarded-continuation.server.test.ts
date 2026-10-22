import { describe, expect, it, vi, beforeEach } from "vitest";

const fixture = vi.hoisted(() => ({
  proposals: [] as Record<string,unknown>[],
  persisted: vi.fn(async (...input: unknown[]) => { void input; return "created" as "created" | "replayed" | "ineligible"; }),
  runStoreCreated: vi.fn()
}));
vi.mock("@/lib/operations/store.server", () => ({
  OperationalStore: class { async list(type:string) { return type === "objective-continuation-proposal" ? fixture.proposals : []; } }
}));
vi.mock("@/lib/persistence/postgres/orchestration-store", () => ({
  PostgresOrchestrationRunStore: class {
    createInTransaction = fixture.runStoreCreated;
  }
}));
vi.mock("./guarded-continuation", () => ({
  persistGuardedContinuation: fixture.persisted
}));
import { runGuardedObjectiveReentry } from "./guarded-continuation.server";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";

const scope = {userId:"owner",portfolioId:"portfolio",companyId:"company",environment:"staging" as const};
const now = "2026-10-22T12:00:00Z";
const proposal = {id:"continuation-1",userId:"owner",portfolioId:"portfolio",companyId:"company",
  environment:"staging",objectiveId:"objective-1",outcomeId:"outcome-1",verificationReceiptHash:"a".repeat(64),
  requiresAdmission:true,consequentialExecutionAuthorized:false};
const objective = {id:"objective-1",createdByUserId:"owner",portfolioId:"portfolio",companyId:"company",environment:"staging"};
const outcome = {id:"outcome-1",verificationReceiptHash:"a".repeat(64)};
const predecessor = {state:"completed",id:"run",source:{type:"objective",id:"objective-1"}};
function database(options:{runs?:object[];receiptHash?:string}={}) {
  const query=vi.fn(async (sql:string) => {
    if(sql.includes("pg_advisory_xact_lock"))return {rows:[],rowCount:1};
    if(sql.includes("entity_type='objective'")) return {rows:[{payload:objective}],rowCount:1};
    if(sql.includes("entity_type='verified-outcome'")) return {rows:[{payload:{...outcome,verificationReceiptHash:options.receiptHash??outcome.verificationReceiptHash}}],rowCount:1};
    if(sql.includes("FROM orchestration_runs"))return {rows:(options.runs??[predecessor]).map(payload=>({payload})),rowCount:1};
    return {rows:[],rowCount:0};
  });
  const transaction=vi.fn(async(fn:(client:{query:typeof query})=>Promise<unknown>)=>fn({query}));
  return {db:{transaction} as unknown as PostgresTransactionalDatabase,query,transaction};
}
describe("scheduler-to-coordinator guarded integration",()=>{
  beforeEach(()=>{fixture.proposals=[proposal];fixture.persisted.mockClear();});
  it("is entirely inert when the feature is disabled",async()=>{
    const {db,transaction}=database();
    expect(await runGuardedObjectiveReentry(db,scope,now,false)).toEqual({created:0,replayed:0});
    expect(transaction).not.toHaveBeenCalled();
    expect(fixture.persisted).not.toHaveBeenCalled();
  });
  it("rechecks scope and verified receipt binding before admission",async()=>{
    fixture.proposals=[{...proposal,companyId:"foreign"}];
    const first=database();
    expect(await runGuardedObjectiveReentry(first.db,scope,now,true)).toEqual({created:0,replayed:0});
    const second=database({receiptHash:"b".repeat(64)});
    fixture.proposals=[proposal];
    expect(await runGuardedObjectiveReentry(second.db,scope,now,true)).toEqual({created:0,replayed:0});
    expect(fixture.persisted).not.toHaveBeenCalled();
  });
  it("does not re-enter while an earlier objective run is active",async()=>{
    const {db}=database({runs:[{...predecessor,state:"executing"}]});
    expect(await runGuardedObjectiveReentry(db,scope,now,true)).toEqual({created:0,replayed:0});
    expect(fixture.persisted).not.toHaveBeenCalled();
  });
  it("passes a completed predecessor to the guarded admission function",async()=>{
    const {db,query}=database();
    expect(await runGuardedObjectiveReentry(db,scope,now,true)).toEqual({created:1,replayed:0});
    expect(fixture.persisted).toHaveBeenCalledOnce();
    expect(fixture.persisted.mock.calls[0][0]).toMatchObject({
      objective,outcome,predecessor,runCount:1
    });
    expect(query.mock.calls.some(([sql])=>String(sql).includes("pg_advisory_xact_lock"))).toBe(true);
  });
});
