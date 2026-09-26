import { describe, expect, it } from "vitest";
import { evaluateBrowserMutationOrigin } from "@/lib/security/browser-mutation-origin";

const env = {
  GETDONE_RUNTIME_ENV: "production",
  GETDONE_AUTH_COOKIE_NAME: "getdone_session",
  GETDONE_WEBAUTHN_ORIGINS: JSON.stringify(["https://app.getdone.example"])
};

function request(path: string, init: RequestInit = {}) {
  return new Request("https://app.getdone.example" + path, init);
}

describe("browser mutation origin protection", () => {
  it("allows safe reads and bearer-only API mutations without CSRF origin coupling", () => {
    expect(evaluateBrowserMutationOrigin(request("/api/control/jobs"), env).allowed).toBe(true);
    expect(evaluateBrowserMutationOrigin(request("/api/control/chat", {
      method: "POST",
      headers: { authorization: "Bearer api-token" }
    }), env).allowed).toBe(true);
  });

  it("requires exact trusted Origin for cookie-authenticated mutations", () => {
    expect(evaluateBrowserMutationOrigin(request("/api/control/chat", {
      method: "POST",
      headers: {
        cookie: "getdone_session=session-token",
        origin: "https://app.getdone.example",
        "sec-fetch-site": "same-origin"
      }
    }), env)).toEqual({ allowed: true });

    expect(evaluateBrowserMutationOrigin(request("/api/control/chat", {
      method: "POST",
      headers: { cookie: "getdone_session=session-token" }
    }), env)).toEqual({ allowed: false, reason: "missing-origin" });

    expect(evaluateBrowserMutationOrigin(request("/api/control/chat", {
      method: "POST",
      headers: {
        cookie: "getdone_session=session-token",
        origin: "https://attacker.example"
      }
    }), env)).toEqual({ allowed: false, reason: "untrusted-origin" });
  });

  it("rejects browser sign-in CSRF before a session cookie exists", () => {
    expect(evaluateBrowserMutationOrigin(request("/api/control/auth/sign-in/verify", {
      method: "POST",
      headers: { origin: "https://attacker.example" }
    }), env).allowed).toBe(false);

    expect(evaluateBrowserMutationOrigin(request("/api/control/auth/sign-in/verify", {
      method: "POST",
      headers: { origin: "https://app.getdone.example" }
    }), env).allowed).toBe(true);
  });

  it("rejects Sec-Fetch-Site cross-site even when an Origin value is present", () => {
    expect(evaluateBrowserMutationOrigin(request("/api/control/decisions/d1", {
      method: "PATCH",
      headers: {
        cookie: "getdone_session=session-token",
        origin: "https://app.getdone.example",
        "sec-fetch-site": "cross-site"
      }
    }), env)).toEqual({ allowed: false, reason: "cross-site" });
  });

  it("does not impose browser CSRF rules on token-authenticated internal or agent routes", () => {
    expect(evaluateBrowserMutationOrigin(request("/api/internal/jobs/run-once", {
      method: "POST"
    }), env).allowed).toBe(true);
    expect(evaluateBrowserMutationOrigin(request("/api/agent/v1/inventory", {
      method: "POST"
    }), env).allowed).toBe(true);
  });
});
