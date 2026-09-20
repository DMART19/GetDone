import { describe, expect, it } from "vitest";
import {
  CAPABILITY_REGISTRY_HASH,
  CAPABILITY_REGISTRY_VERSION,
  capabilityRegistry
} from "@/lib/domain/capabilities";

describe("capability registry versioning", () => {
  it("publishes a deterministic registry version and hash", () => {
    expect(CAPABILITY_REGISTRY_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(CAPABILITY_REGISTRY_HASH).toMatch(/^[a-f0-9]{64}$/);
  });

  it("versions every runtime capability contract", () => {
    expect(capabilityRegistry.every((capability) => capability.schemaVersion.length > 0)).toBe(true);
    expect(capabilityRegistry.every((capability) => capability.authorityBindings)).toBe(true);
  });
});
