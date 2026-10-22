import { describe, expect, it } from "vitest";
import { recommendFailureRecovery } from "./failure-recovery";
const safe = {code:"TIMEOUT",operation:"read" as const,authorizationValid:true,verifiedFailure:true,attempts:1,maxAttempts:3};
describe("governed failure advice", () => {
  it("permits only bounded read-only retry", () => expect(recommendFailureRecovery(safe)).toBe("retry_read_only"));
  it("requires reconciliation for possibly completed writes", () => expect(recommendFailureRecovery({...safe,operation:"write"})).toBe("reconcile_first"));
  it("requires owner when authorization or failure proof is missing", () => {
    expect(recommendFailureRecovery({...safe,authorizationValid:false})).toBe("request_owner");
    expect(recommendFailureRecovery({...safe,verifiedFailure:false})).toBe("request_owner");
  });
  it("stops exhausted attempts", () => expect(recommendFailureRecovery({...safe,attempts:3})).toBe("stop"));
});
