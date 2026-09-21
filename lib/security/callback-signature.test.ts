import { describe, expect, it } from "vitest";
import {
  computeHmacSha256,
  requireValidHmacSha256Callback,
  verifyHmacSha256Callback
} from "@/lib/security/callback-signature";

describe("callback signature verification", () => {
  const secret = "unit-test-secret";
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
  it("covers unsigned timestamp variants, raw bytes, custom prefixes, and validation failures", () => {
    const bytes = new TextEncoder().encode(rawBody);
    const noTimestamp = computeHmacSha256(bytes, secret);
    expect(verifyHmacSha256Callback({ rawBody: bytes, signature: noTimestamp, secret })).toBe(true);

    const custom = computeHmacSha256(rawBody, secret, undefined, "hmac=");
    expect(verifyHmacSha256Callback({
      rawBody,
      signature: custom,
      secret,
      prefix: "hmac="
    })).toBe(true);

    expect(() => computeHmacSha256(rawBody, "")).toThrow(/secret is required/i);
    expect(() => verifyHmacSha256Callback({
      rawBody,
      signature: "not-hex",
      secret
    })).toThrow(/invalid format/i);
    expect(() => verifyHmacSha256Callback({
      rawBody,
      signature: computeHmacSha256(rawBody, secret, "1790006400"),
      secret,
      timestamp: "bad-time",
      nowMs
    })).toThrow(/timestamp has an invalid format/i);

    const valid = computeHmacSha256(rawBody, secret, timestamp);
    expect(() => requireValidHmacSha256Callback({
      rawBody: rawBody + "tampered",
      signature: valid,
      secret,
      timestamp,
      nowMs
    })).toThrow(/verification failed/i);
    expect(() => verifyHmacSha256Callback({
      rawBody,
      signature: valid,
      secret: "",
      timestamp,
      nowMs
    })).toThrow(/secret is required/i);
  });

});
