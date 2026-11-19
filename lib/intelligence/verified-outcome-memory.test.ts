import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { VerifiedOutcome } from "@/lib/operations/outcomes";
import { verifiedOutcomeMemory } from "./verified-outcome-memory";

const time = Date.parse("2026-10-22T12:00:00Z");
const scope = { userId:"owner", portfolioId:"portfolio", companyId:"company", environment:"staging" as const };
const base = {
  id:"outcome-1",scope,topic:"revenue",findingId:"finding",recommendationId:"recommendation",
  recommendationKind:"github_repository_health",predictedOutcome:"validated",
  approvedPreviewHash:"a".repeat(64),executionReceiptId:"execution",
  executionReceiptHash:"b".repeat(64),verificationReceiptId:"receipt",
  verificationReceiptHash:"d".repeat(64),verificationResult:"verified" as const,
  objectiveImpact:null,observedAt:"2026-10-21T12:00:00Z"
};
const outcome: VerifiedOutcome = {...base,outcomeHash:sha256Hex(base)};
describe("verified operational memory",()=>{
  it("includes only independently verified, scoped and unexpired evidence",()=>{
    const item=verifiedOutcomeMemory([outcome],scope,time);
    expect(item).toHaveLength(1);
    expect(item[0]).toMatchObject({kind:"memory",provenance:"verification-receipt:receipt"});
  });
  it("filters foreign businesses, bad hashes, failed and stale outcomes",()=>{
    expect(verifiedOutcomeMemory([outcome],{...scope,companyId:"foreign"},time)).toHaveLength(0);
    expect(verifiedOutcomeMemory([{...outcome,outcomeHash:"bad"}],scope,time)).toHaveLength(0);
    expect(verifiedOutcomeMemory([{...outcome,verificationResult:"failed"}],scope,time)).toHaveLength(0);
    expect(verifiedOutcomeMemory([outcome],scope,time+31*86_400_000)).toHaveLength(0);
  });
  it("never represents action verification as proven business causality",()=>{
    expect(verifiedOutcomeMemory([outcome],scope,time)[0].content).toContain('"causalityProven":false');
  });
});
