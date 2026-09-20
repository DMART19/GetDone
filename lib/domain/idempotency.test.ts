import { describe, expect, it } from "vitest";
import { claimIdempotency, MemoryIdempotencyStore } from "@/lib/domain/idempotency";

describe("idempotency", () => {
  it("returns the same logical claim for a retry", async () => {
    const store = new MemoryIdempotencyStore();
    const first = await claimIdempotency(store, "request-1234", "fingerprint-a");
    const retry = await claimIdempotency(store, "request-1234", "fingerprint-a");

    expect(first.isNew).toBe(true);
    expect(retry.isNew).toBe(false);
  });

  it("rejects key reuse for a different request", async () => {
    const store = new MemoryIdempotencyStore();
    await claimIdempotency(store, "request-1234", "fingerprint-a");
    await expect(claimIdempotency(store, "request-1234", "fingerprint-b")).rejects.toThrow();
  });
});
