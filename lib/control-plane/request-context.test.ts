import { describe, expect, it } from "vitest";
import {
  createRequestContext,
  parseEnvironment,
  readIdempotencyKey
} from "@/lib/control-plane/request-context";

describe("request context boundaries", () => {
  it("parses only known environments and defaults unknown values to development", () => {
    expect(parseEnvironment("production")).toBe("production");
    expect(parseEnvironment("staging")).toBe("staging");
    expect(parseEnvironment("development")).toBe("development");
    expect(parseEnvironment("unexpected")).toBe("development");
    expect(parseEnvironment(undefined)).toBe("development");
  });

  it("accepts safe idempotency keys and treats missing keys as absent", () => {
    const headers = new Headers({ "idempotency-key": " request_1234 " });
    expect(readIdempotencyKey(headers)).toBe("request_1234");
    expect(readIdempotencyKey(new Headers())).toBeNull();
  });

  it("rejects short, overlong, and unsafe idempotency keys", () => {
    expect(() => readIdempotencyKey(new Headers({ "idempotency-key": "short" }))).toThrow(/Invalid/);
    expect(() => readIdempotencyKey(new Headers({ "idempotency-key": "x".repeat(161) }))).toThrow(/Invalid/);
    expect(() => readIdempotencyKey(new Headers({ "idempotency-key": "unsafe value!" }))).toThrow(/Invalid/);
  });

  it("creates scoped trusted contexts and rejects missing trusted identity", () => {
    const context = createRequestContext({
      actor: { type: "user", id: "user-1" },
      scope: { userId: "user-1", portfolioId: "portfolio-1" },
      environment: "staging",
      correlationId: "correlation-1"
    });
    expect(context).toMatchObject({
      correlationId: "correlation-1",
      environment: "staging",
      actor: { id: "user-1" },
      scope: { portfolioId: "portfolio-1" }
    });

    expect(() => createRequestContext({
      actor: { type: "user", id: "" },
      scope: { userId: "user-1" }
    })).toThrow(/Trusted identity/);
    expect(() => createRequestContext({
      actor: { type: "user", id: "user-1" },
      scope: { userId: "" }
    })).toThrow(/Trusted identity/);
  });
});
