import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { PostgresDisasterRecoveryPlanner } from "@/lib/persistence/postgres/disaster-recovery-store";
import { createPersistedJobExecutionSpec } from "@/lib/execution/job-execution-router";
import { createJobQueueEnvelope } from "@/lib/execution/job-runtime-contracts";

function envelope(jobId: string) {
  return createJobQueueEnvelope({
    id:`queue:${jobId}`,jobId,taskId:`task:${jobId}`,
    scope:{userId:"owner",portfolioId:"p",companyId:"c",environment:"staging"},
    authorizationConsumptionHash:`consumption:${jobId}`,
    idempotencyKey:`enqueue:${jobId}`,
    scheduledAt:"2026-09-25T10:00:00.000Z",
    createdAt:"2026-09-25T10:00:00.000Z"
  });
}

class FakeDatabase {
  incident: { hash:string; payload:any } | null = null;
  decisions = new Map<string,string>();
  cleared = false;
  async transaction<T>(operation:(client:FakeDatabase)=>Promise<T>) { return operation(this); }
  async query(text:string, values:readonly unknown[] = []) {
    if (text.includes("INSERT INTO disaster_recovery_incidents")) {
      if (this.incident) return { rows:[], rowCount:0 };
      this.incident={hash:String(values[5]),payload:JSON.parse(String(values[6]))};
      return { rows:[], rowCount:1 };
    }
    if (text.includes("SELECT incident_hash,payload")) {
      return { rows:this.incident ? [{incident_hash:this.incident.hash,payload:this.incident.payload}] : [], rowCount:this.incident ? 1 : 0 };
    }
    if (text.includes("SELECT status FROM disaster_recovery_incidents")) {
      return { rows:this.incident ? [{status:"active"}] : [], rowCount:this.incident ? 1 : 0 };
    }
    if (text.includes("FROM job_runtime_state r")) {
      const jobId="job-a";
      const env=envelope(jobId);
      const request={
        id:"request-a",jobId,scope:env.scope,capability:"email.send",input:{x:1},
        inputHash:sha256Hex({x:1}),authorizationConsumptionHash:env.authorizationConsumptionHash,
        idempotencyKey:"provider-a",timeoutMs:1000,attempt:1
      };
      const spec=createPersistedJobExecutionSpec({
        kind:"business-action",jobId,authoritativeJobVersion:1,
        authoritativeJobHash:"a".repeat(64),request
      });
      return { rows:[{
        job_id:jobId,envelope:env,envelope_hash:env.envelopeHash,runtime_state:"queued",
        version:1,state_hash:"b".repeat(64),attempt:0,scheduled_at:env.scheduledAt,
        cancelled_reason:null,spec_payload:spec,business_payload:null
      }], rowCount:1 };
    }
    if (text.includes("INSERT INTO job_disaster_recovery_decisions")) {
      const key=`${values[0]}:${values[1]}`;
      if (this.decisions.has(key)) return {rows:[],rowCount:0};
      this.decisions.set(key,String(values[11]));
      return {rows:[],rowCount:1};
    }
    if (text.includes("SELECT decision_hash FROM job_disaster_recovery_decisions")) {
      const key=`${values[0]}:${values[1]}`;
      const hash=this.decisions.get(key);
      return {rows:hash ? [{decision_hash:hash}] : [],rowCount:hash ? 1 : 0};
    }
    if (text.includes("UPDATE job_disaster_recovery_decisions")) {
      this.cleared=true;
      return {rows:[],rowCount:1};
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }
}

describe("PostgresDisasterRecoveryPlanner", () => {
  it("persists idempotent incident evidence and deterministic Job decisions", async () => {
    const db=new FakeDatabase();
    const planner=new PostgresDisasterRecoveryPlanner(db as unknown as import("@/lib/persistence/postgres/client").PostgresTransactionalDatabase);
    const input={
      id:"incident-a",
      declaredAt:"2026-09-25T10:00:00.000Z",
      lostPrimaryAt:"2026-09-25T09:59:00.000Z",
      sourceBackupSha256:"1".repeat(64),
      sourceSnapshotHash:"2".repeat(64)
    };
    const first=await planner.declareIncident(input);
    const second=await planner.declareIncident(input);
    expect(second.incidentHash).toBe(first.incidentHash);
    const report=await planner.planIncident("incident-a","2026-09-25T10:01:00.000Z");
    expect(report.counts).toEqual({resume:1,reconcile:0,blocked:0});
    expect(report.decisions[0]).toMatchObject({jobId:"job-a",decision:"resume"});
  });

  it("requires hashed reconciliation evidence", async () => {
    const db=new FakeDatabase();
    const planner=new PostgresDisasterRecoveryPlanner(db as never);
    await expect(planner.clearReconciliation({
      incidentId:"i",jobId:"j",clearedAt:"2026-09-25T10:00:00.000Z",evidenceHash:"bad"
    })).rejects.toMatchObject({code:"VALIDATION_FAILED"});
    await planner.clearReconciliation({
      incidentId:"i",jobId:"j",clearedAt:"2026-09-25T10:00:00.000Z",evidenceHash:"f".repeat(64)
    });
    expect(db.cleared).toBe(true);
  });
});
