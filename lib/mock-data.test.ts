import { describe, expect, it } from "vitest";
import { decisions, getResource, resources } from "@/lib/mock-data";

describe("development seed data", () => {
  it("contains the screenshot resource detail target", () => {
    expect(getResource("dc-west")?.name).toBe("DC West");
  });

  it("keeps decisions pending and non-authoritative", () => {
    expect(decisions.every((decision) => decision.status === "pending")).toBe(true);
  });

  it("uses stable unique resource ids", () => {
    expect(new Set(resources.map((resource) => resource.id)).size).toBe(resources.length);
  });
});
