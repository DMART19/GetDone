import { describe, expect, it } from "vitest";
import {
  SUPPORTED_NODE_CAPABILITIES,
  isSupportedNodeCapabilityName
} from "@/lib/nodes/capability-catalog";

describe("Node capability catalog", () => {
  it("publishes the bounded Phase 28.4 local capability set", () => {
    expect(SUPPORTED_NODE_CAPABILITIES).toEqual([
      "runtime.docker",
      "runtime.containerd",
      "runtime.python",
      "runtime.nodejs",
      "runtime.java",
      "tool.git",
      "runtime.ollama",
      "gpu.cuda",
      "tool.ffmpeg"
    ]);
  });

  it("rejects unknown local capability names", () => {
    expect(isSupportedNodeCapabilityName("runtime.docker")).toBe(true);
    expect(isSupportedNodeCapabilityName("runtime.podman")).toBe(false);
    expect(isSupportedNodeCapabilityName("compute.cpu.light")).toBe(false);
  });
});
