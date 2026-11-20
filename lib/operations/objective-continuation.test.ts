import { describe, expect, it } from "vitest";
import { adviseObjectiveContinuation } from "./objective-continuation";
import type { ObjectiveRecord } from "@/lib/domain/objective-inbox";

const base = {
  id: "objective-1",
  status: "queued" as ObjectiveRecord["status"],
  dependsOnObjectiveIds: [] as string[],
  successCriteria: ["Verified result"]
};

describe("objective continuation advice", () => {
  it.each(["completed", "cancelled"] as const)("stops terminal %s objectives", status => {
    expect(adviseObjectiveContinuation({ ...base, status }, {}).decision).toBe("stop");
  });
  it.each(["blocked", "needs_owner_input"] as const)("never bypasses %s", status => {
    const result = adviseObjectiveContinuation({ ...base, status }, {});
    expect(result).toMatchObject({ decision: "wait_for_owner", requiresAdmission: false });
  });
  it("does not continue with unknown or incomplete dependencies", () => {
    const objective = { ...base, dependsOnObjectiveIds: ["other"] };
    expect(adviseObjectiveContinuation(objective, {}).decision).toBe("wait_for_dependencies");
    expect(adviseObjectiveContinuation(objective, { other: "executing" }).decision).toBe("wait_for_dependencies");
    expect(adviseObjectiveContinuation(objective, { other: "completed" }).decision).toBe("continue_existing_plan");
  });
  it("requires investigation when success criteria are missing", () => {
    expect(adviseObjectiveContinuation({ ...base, successCriteria: [] }, {}).decision).toBe("investigate");
  });
  it.each(["failed", "new_work_required", "partially_completed"] as const)("proposes governed replanning for %s", status => {
    expect(adviseObjectiveContinuation({ ...base, status }, {})).toMatchObject({
      decision: "propose_replan", requiresAdmission: true
    });
  });
  it("never grants execution authority for an eligible objective", () => {
    expect(adviseObjectiveContinuation(base, {})).toMatchObject({
      decision: "continue_existing_plan", requiresAdmission: true
    });
  });
});
