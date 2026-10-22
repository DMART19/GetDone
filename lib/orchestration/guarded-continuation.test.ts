import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { normalizeObjectiveIntake } from "@/lib/domain/objective-inbox";
import { createOrchestrationRun, createOrchestrationSourceRef, type OrchestrationRunRecord } from "./contracts";
import type { VerifiedOutcome } from "@/lib/operations/outcomes";
import { createGuardedContinuation, persistGuardedContinuation } from "./guarded-continuation";

const before = "2026-10-21T12:00:00Z";
const after = "2026-10-22T12:00:00Z";
const scope = { userId: "owner", portfolioId: "portfolio", companyId: "company", environment: "staging" as const };
const objective = normalizeObjectiveIntake({
  rawText: JSON.stringify({ goal: "Grow revenue", successCriteria: ["Verified revenue growth"] }),
  source: "structured_json"
}, {scope, correlationId:"test", now:before, nextId:()=>"objective-1"})[0];
const started = createOrchestrationRun({
  id:"orchestration:objective:objective-1", correlationId:"objective:objective-1",
  source:createOrchestrationSourceRef("objective",objective.id,objective),
  scope, createdAt:before,updatedAt:before
});
const ref = (id:string) => ({id,hash:"b".repeat(64)});
const completeBase = {
  ...started, state:"completed" as const, version:12, updatedAt:after,
  checkpoints: {
    contextSnapshot:ref("context"),plannerInput:ref("input"),plan:ref("plan"),
    validationReceipt:ref("validation"),policySnapshot:ref("policy"),taskDag:ref("dag"),
    decisionIds:[],authorizationGrants:[{...ref("grant"),disposition:"AUTO" as const}],
    tasks:[{...ref("task"),authorizationConsumptionHash:"c".repeat(64)}],jobIds:["job"],
    verificationRequestIds:["verification"],verifiedOutcomes:[{
      id:"outcome", verificationReceiptId:"receipt",verificationReceiptHash:"d".repeat(64)
    }]
  }
};
const predecessor = { ...completeBase, recordHash:sha256Hex(completeBase) } as OrchestrationRunRecord;
const outcomeBase = {
  id:"verified-outcome-1",scope, topic:"revenue",findingId:"finding",recommendationId:"recommendation",
  recommendationKind:"github_repository_health",predictedOutcome:"validated",approvedPreviewHash:"a".repeat(64),
  executionReceiptId:"execution",executionReceiptHash:"b".repeat(64),
  verificationReceiptId:"receipt",verificationReceiptHash:"d".repeat(64),
  verificationResult:"verified" as const,objectiveImpact:null,jobId:"job",observedAt:"2026-10-22T11:00:00Z",objectiveId:objective.id
};
const outcome:VerifiedOutcome = {...outcomeBase,outcomeHash:sha256Hex(outcomeBase)};
const input = {objective,outcome,predecessor,runCount:1,now:after};

describe("guarded coordinator re-entry",()=>{
  it("creates an accepted non-authoritative objective run with no inherited grants",()=>{
    const result=createGuardedContinuation(input)!;
    expect(result).toMatchObject({state:"accepted",authority:"coordination-only",source:{type:"objective",id:objective.id}});
    expect(result.checkpoints.authorizationGrants).toEqual([]);
    expect(result.checkpoints.verifiedOutcomes).toEqual([]);
  });
  it("rejects forged verification evidence and cross-tenant lineage",()=>{
    expect(()=>createGuardedContinuation({...input,outcome:{...outcome,verificationReceiptHash:"0".repeat(64)}})).toThrow();
    expect(()=>createGuardedContinuation({...input,objective:{...objective,companyId:"another"}})).toThrow();
    expect(()=>createGuardedContinuation({...input,predecessor:{...predecessor,recordHash:"wrong"}})).toThrow();
    const mismatched = {...completeBase, checkpoints: {...completeBase.checkpoints, jobIds:["different-job"]}};
    expect(()=>createGuardedContinuation({...input,predecessor:{...mismatched,recordHash:sha256Hex(mismatched)} as OrchestrationRunRecord})).toThrow();
  });
  it("blocks completed, owner-held, dependent and unmeasurable objectives",()=>{
    for(const status of ["completed","blocked","needs_owner_input"] as const)
      expect(createGuardedContinuation({...input,objective:{...objective,status}})).toBeNull();
    expect(createGuardedContinuation({...input,objective:{...objective,dependsOnObjectiveIds:["missing"]}})).toBeNull();
    expect(createGuardedContinuation({...input,objective:{...objective,successCriteria:[]}})).toBeNull();
  });
  it("rejects already consumed outcome timestamps",()=>{
    const laterBase={...completeBase,createdAt:after,updatedAt:after};
    const later={...laterBase,recordHash:sha256Hex(laterBase)} as OrchestrationRunRecord;
    expect(createGuardedContinuation({...input,predecessor:later})).toBeNull();
  });
  it("caps reasoning cycles before creating further runs",()=>{
    expect(createGuardedContinuation({...input,runCount:3})).toBeNull();
  });
  it("replays the same continuation exactly once",async()=>{
    const saved = new Map<string,OrchestrationRunRecord>();
    const create=vi.fn(async(record:OrchestrationRunRecord)=>{
      saved.set(record.id,record);
      return {status:"created" as const,record};
    });
    const runs={get:async(id:string)=>saved.get(id)??null,create};
    expect(await persistGuardedContinuation({...input,runs})).toBe("created");
    expect(await persistGuardedContinuation({...input,now:"2026-10-22T12:01:00Z",runs})).toBe("replayed");
    expect(create).toHaveBeenCalledTimes(1);
  });
});
