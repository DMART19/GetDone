import { describe, expect, it } from "vitest";
import { readProviderConcurrencyConfigFromEnv } from "@/lib/execution/provider-concurrency.server";

describe("provider concurrency configuration", () => {
  it("parses default and provider-specific limits", () => {
    expect(readProviderConcurrencyConfigFromEnv({
      GETDONE_PROVIDER_CONCURRENCY_LIMIT: "5",
      GETDONE_PROVIDER_CONCURRENCY_LEASE_SECONDS: "90",
      GETDONE_PROVIDER_CONCURRENCY_LIMITS_JSON: JSON.stringify({
        "mail-adapter": 2,
        "slack-adapter": 3
      })
    })).toEqual({
      defaultLimit: 5,
      leaseSeconds: 90,
      limits: {
        "mail-adapter": 2,
        "slack-adapter": 3
      }
    });
  });

  it("rejects malformed limits", () => {
    expect(() => readProviderConcurrencyConfigFromEnv({
      GETDONE_PROVIDER_CONCURRENCY_LIMITS_JSON: "{bad"
    })).toThrow(/valid JSON/i);
    expect(() => readProviderConcurrencyConfigFromEnv({
      GETDONE_PROVIDER_CONCURRENCY_LIMITS_JSON: JSON.stringify({
        "mail-adapter": 0
      })
    })).toThrow(/positive integer/i);
  });
});
