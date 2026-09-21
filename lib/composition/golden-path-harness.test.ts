import { describe, expect, it } from "vitest";
import { runDeterministicGoldenPath } from "@/lib/composition/golden-path-harness";

const expectedStages = [
  "objective",
  "plan",
  "validation",
  "policy",
  "decision",
  "approval",
  "task",
  "job",
  "placement",
  "governor",
  "reservation",
  "credential-admission",
  "dispatch-admission",
  "start-verification",
  "job-running",
  "completion-verification",
  "outcome",
  "memory",
  "resource-release"
] as const;

describe("cross-phase deterministic golden path", () => {
  it("composes the full governed path without claiming production execution", async () => {
    const result = await runDeterministicGoldenPath();

    expect(result.simulationOnly).toBe(true);
    expect(result.productionExecutionClaimed).toBe(false);
    expect(result.stages.map((item) => item.name)).toEqual(expectedStages);
    expect(result.stages.every((item) => item.status === "passed")).toBe(true);
    expect(result.stages.every((item) => item.artifactHash.length === 64)).toBe(true);

    expect(result.final).toEqual({
      jobState: "succeeded",
      outcomeState: "verified",
      memoryAuthority: "advisory",
      reservationState: "released",
      credentialState: "released",
      reservedCapacity: { cpu: 0, memoryMb: 0 }
    });
  });

  it("is deterministic across repeated runs", async () => {
    const first = await runDeterministicGoldenPath();
    const second = await runDeterministicGoldenPath();

    expect(second.resultHash).toBe(first.resultHash);
    expect(second.stages).toEqual(first.stages);
    expect(second.final).toEqual(first.final);
  });

  it("places Job running only after independent resource-start verification", async () => {
    const result = await runDeterministicGoldenPath();
    const dispatchIndex = result.stages.findIndex((item) => item.name === "dispatch-admission");
    const startIndex = result.stages.findIndex((item) => item.name === "start-verification");
    const runningIndex = result.stages.findIndex((item) => item.name === "job-running");

    expect(dispatchIndex).toBeGreaterThan(-1);
    expect(startIndex).toBeGreaterThan(dispatchIndex);
    expect(runningIndex).toBeGreaterThan(startIndex);
  });

  it("does not release capacity before authoritative completion and outcome truth", async () => {
    const result = await runDeterministicGoldenPath();
    const completionIndex = result.stages.findIndex((item) => item.name === "completion-verification");
    const outcomeIndex = result.stages.findIndex((item) => item.name === "outcome");
    const memoryIndex = result.stages.findIndex((item) => item.name === "memory");
    const releaseIndex = result.stages.findIndex((item) => item.name === "resource-release");

    expect(outcomeIndex).toBeGreaterThan(completionIndex);
    expect(memoryIndex).toBeGreaterThan(outcomeIndex);
    expect(releaseIndex).toBeGreaterThan(memoryIndex);
  });
});
