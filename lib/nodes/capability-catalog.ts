export const NODE_CAPABILITY_CATALOG_VERSION = "1.0.0";

export const SUPPORTED_NODE_CAPABILITIES = Object.freeze([
  "runtime.docker",
  "runtime.containerd",
  "runtime.python",
  "runtime.nodejs",
  "runtime.java",
  "tool.git",
  "runtime.ollama",
  "gpu.cuda",
  "tool.ffmpeg"
] as const);

export type SupportedNodeCapabilityName =
  (typeof SUPPORTED_NODE_CAPABILITIES)[number];

const supported = new Set<string>(SUPPORTED_NODE_CAPABILITIES);

export function isSupportedNodeCapabilityName(
  name: string
): name is SupportedNodeCapabilityName {
  return supported.has(name);
}
