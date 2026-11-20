import { describe, expect, it } from "vitest";
import { normalizeObjectiveIntake } from "@/lib/domain/objective-inbox";
import { evaluateObjective } from "./objective-evaluation";
const scope = {userId:"owner",portfolioId:"portfolio",companyId:"business",environment:"staging" as const};
const objective = normalizeObjectiveIntake({
  rawText: JSON.stringify({goal:"Grow monthly revenue",successCriteria:["Measured revenue increased"]}),
  source:"structured_json"
}, {scope,correlationId:"correlation",now:"2026-10-22T12:00:00Z",nextId:()=>"objective-1"})[0];
const metric = {topic:"revenue",key:"monthlyRevenue",target:10000,operator:"gte" as const};
describe("continuation is integrated with measurable objective evaluation", () => {
  it("never authorizes execution when evidence is missing", () => {
    const result = evaluateObjective(scope,objective,metric,[],"2026-10-22T12:00:00Z");
    expect(result).toMatchObject({consequentialExecutionAuthorized:false,achieved:false,ownerInputRequired:true});
    expect(result.missingEvidence).toHaveLength(1);
    expect(result.continuation.requiresAdmission).toBe(true);
  });
  it("blocks continuation when dependencies are unknown", () => {
    const dependent = {...objective,dependsOnObjectiveIds:["prerequisite"]};
    const result = evaluateObjective(scope,dependent,metric,[],"2026-10-22T12:00:00Z");
    expect(result.continuation.decision).toBe("wait_for_dependencies");
    expect(result.recommendedNextAction).toContain("prerequisite");
  });
  it("never resumes cancelled objectives", () => {
    const result = evaluateObjective(scope,{...objective,status:"cancelled"},metric,[],"2026-10-22T12:00:00Z");
    expect(result.continuation).toMatchObject({decision:"stop",requiresAdmission:false});
  });
});
