import { describe, expect, it } from "vitest";
import { claimIdempotency, MemoryIdempotencyStore } from "@/lib/domain/idempotency";

describe("atomic idempotency claims", () => {
  it("returns CREATED then IN_PROGRESS for the same logical retry", async () => {
    const store = new MemoryIdempotencyStore();
    const first = await claimIdempotency(store, "request-1234", "fingerprint-a");
    const retry = await claimIdempotency(store, "request-1234", "fingerprint-a");

    expect(first.state).toBe("CREATED");
    expect(retry.state).toBe("IN_PROGRESS");
  });

  it("returns COMPLETED with the stored result after completion", async () => {
    const store = new MemoryIdempotencyStore();
    await claimIdempotency(store, "request-1234", "fingerprint-a");
    await store.complete("request-1234", "fingerprint-a", { ok: true }, "2026-09-20T18:00:00Z");

    const retry = await claimIdempotency<{ ok: boolean }>(store, "request-1234", "fingerprint-a");
    expect(retry.state).toBe("COMPLETED");
    expect(retry.record.result).toEqual({ ok: true });
  });

  it("rejects key reuse for a different request", async () => {
    const store = new MemoryIdempotencyStore();
    await claimIdempotency(store, "request-1234", "fingerprint-a");
    await expect(claimIdempotency(store, "request-1234", "fingerprint-b")).rejects.toThrow();
  });
});
