import { describe, expect, it } from "vitest";
import { buildSecurityHeaders } from "./security-headers.mjs";

function map(env: Record<string, string>) {
  return Object.fromEntries(buildSecurityHeaders(env).map(({ key, value }) => [key, value]));
}

describe("response security headers", () => {
  it("sets CSP, frame, MIME, referrer, permissions, and isolation protections", () => {
    const headers = map({ GETDONE_RUNTIME_ENV: "staging" });
    expect(headers["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(headers["Content-Security-Policy"]).toContain("object-src 'none'");
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(headers["Content-Security-Policy"]).toContain("form-action 'self'");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Permissions-Policy"]).toContain("camera=()");
    expect(headers["Permissions-Policy"]).toContain("publickey-credentials-get=(self)");
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
  });

  it("adds HSTS and upgrade-insecure-requests only in production", () => {
    const production = map({ GETDONE_RUNTIME_ENV: "production" });
    expect(production["Strict-Transport-Security"]).toBe(
      "max-age=31536000; includeSubDomains"
    );
    expect(production["Content-Security-Policy"]).toContain("upgrade-insecure-requests");
    expect(production["Content-Security-Policy"]).not.toContain("'unsafe-eval'");

    const staging = map({ GETDONE_RUNTIME_ENV: "staging" });
    expect(staging["Strict-Transport-Security"]).toBeUndefined();
    expect(staging["Content-Security-Policy"]).not.toContain("upgrade-insecure-requests");
    expect(staging["Content-Security-Policy"]).toContain("'unsafe-eval'");
  });
});
