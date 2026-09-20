import { describe, expect, it } from "vitest";
import {
  computeHmacSha256,
  requireValidHmacSha256Callback,
  verifyHmacSha256Callback
} from "@/lib/security/callback-signature";

describe("callback signature verification", () => {
  const secret = "server-side-test-secret";
  const rawBody = JSON.stringify({ event: "resource.health", resourceId: "resource-a" });
  const timestamp = "1790006400";
  const nowMs = Number(timestamp) * 1000;

  it("accepts a valid HMAC over timestamp and raw body", () => {
    const signature = computeHmacSha256(rawBody, secret, timestamp);
    expect(verifyHmacSha256Callback({ rawBody, signature, secret, timestamp, nowMs })).toBe(true);
  });

  it("rejects a forged callback", () => {
    const signature = computeHmacSha256(rawBody, secret, timestamp);
    expect(verifyHmacSha256Callback({
      rawBody: JSON.stringify({ event: "resource.ready", resourceId: "resource-a" }),
      signature,
      secret,
      timestamp,
      nowMs
    })).toBe(false);
  });

  it("rejects stale callbacks outside the replay window", () => {
    const signature = computeHmacSha256(rawBody, secret, timestamp);
    expect(() => requireValidHmacSha256Callback({
      rawBody,
      signature,
      secret,
      timestamp,
      nowMs: nowMs + 301_000,
      toleranceSeconds: 300
    })).toThrow();
  });
});
