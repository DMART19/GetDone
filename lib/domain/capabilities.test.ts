import { describe, expect, it } from "vitest";
import { getCapability, requireEnabledCapability } from "@/lib/domain/capabilities";

describe("capability registry", () => {
  it("keeps high-impact production deployment behind strong approval", () => {
    const capability = requireEnabledCapability("production.deploy");
    expect(capability.productionEffect).toBe(true);
    expect(capability.approval).toBe("strong-approval");
  });

  it("fails closed for unknown capabilities", () => {
    expect(getCapability("execute_anything")).toBeUndefined();
    expect(() => requireEnabledCapability("execute_anything")).toThrow();
  });
});
