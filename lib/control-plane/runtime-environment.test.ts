import { describe, expect, it } from "vitest";
import {
  developmentApiAllowed,
  parseAuthoritativeRuntimeEnvironment
} from "@/lib/control-plane/runtime-environment";

describe("server-authoritative runtime environment", () => {
  it("fails closed when GETDONE_RUNTIME_ENV is missing or invalid", () => {
    expect(() => parseAuthoritativeRuntimeEnvironment(undefined)).toThrow();
    expect(() => parseAuthoritativeRuntimeEnvironment("prod")).toThrow();
  });

  it("accepts only the canonical runtime environments", () => {
    expect(parseAuthoritativeRuntimeEnvironment("development")).toBe("development");
    expect(parseAuthoritativeRuntimeEnvironment("staging")).toBe("staging");
    expect(parseAuthoritativeRuntimeEnvironment("production")).toBe("production");
  });

  it("never allows dev APIs when Node runs in production", () => {
    expect(developmentApiAllowed({
      runtimeEnvironment: "development",
      nodeEnvironment: "production",
      dataMode: "development-seed"
    })).toBe(false);
  });

  it("never allows dev APIs when the authoritative runtime is production", () => {
    expect(developmentApiAllowed({
      runtimeEnvironment: "production",
      nodeEnvironment: "development",
      dataMode: "development-seed"
    })).toBe(false);
  });

  it("requires the explicit development seed data mode", () => {
    expect(developmentApiAllowed({
      runtimeEnvironment: "development",
      nodeEnvironment: "development",
      dataMode: "authoritative"
    })).toBe(false);
  });
});
