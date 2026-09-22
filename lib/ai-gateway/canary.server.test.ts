import { describe, expect, it } from "vitest";
import {
  assertInternalAIGatewayToken,
  runLiveOpenRouterCanary
} from "@/lib/ai-gateway/canary.server";

describe("live OpenRouter canary guard", () => {
  it("requires a server-side internal AI token and validates it timing-safely", () => {
    const request = (token?: string) => new Request("https://getdone.test/api/internal/ai/canary", {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {}
    });

    expect(() => assertInternalAIGatewayToken(request("x"), {}))
      .toThrow(/INTERNAL_AI_TOKEN/i);
    expect(() => assertInternalAIGatewayToken(
      request("wrong"),
      { GETDONE_INTERNAL_AI_TOKEN: "correct-secret" }
    )).toThrow(/authentication failed/i);
    expect(() => assertInternalAIGatewayToken(
      request("correct-secret"),
      { GETDONE_INTERNAL_AI_TOKEN: "correct-secret" }
    )).not.toThrow();
  });

  it("refuses live provider canaries outside staging/production before touching persistence", async () => {
    await expect(runLiveOpenRouterCanary({
      GETDONE_RUNTIME_ENV: "development"
    })).rejects.toThrow(/staging or production/i);
  });
});
