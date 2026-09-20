import { createHash } from "node:crypto";

export function canonicalSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(",")}]`;

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));

    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalSerialize(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

export function sha256Hex(value: unknown) {
  return createHash("sha256").update(canonicalSerialize(value)).digest("hex");
}
