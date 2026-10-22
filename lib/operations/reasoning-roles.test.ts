import { describe, expect, it } from "vitest";
import { REASONING_ROLES, reasoningRoleRequest } from "./reasoning-roles";
describe("advisory reasoning roles", () => {
  it.each(REASONING_ROLES)("%s cannot gain execution, approval, or verification authority", role => {
    expect(reasoningRoleRequest(role, "Investigate objective")).toMatchObject({
      mayExecute: false, mayAuthorize: false, mayVerifyOutcome: false
    });
  });
  it("rejects blank objectives", () => {
    expect(() => reasoningRoleRequest("planner", " ")).toThrow();
  });
  it("keeps researcher evidence-only", () => {
    expect(reasoningRoleRequest("researcher", "Find evidence").mayProposePlan).toBe(false);
  });
});
