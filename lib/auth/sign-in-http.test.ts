import { beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneError } from "@/lib/control-plane/errors";

const serviceMocks = vi.hoisted(() => ({
  begin: vi.fn(),
  verify: vi.fn()
}));

vi.mock("@/lib/persistence/postgres/runtime.server", () => ({
  getPostgresRuntimeFromEnv: vi.fn(() => ({ database: {} }))
}));

vi.mock("@/lib/auth/postgres-sign-in", () => ({
  PostgresPasskeySignInService: class {
    begin(userId: string) {
      return serviceMocks.begin(userId);
    }
    verify(challengeId: string, credential: unknown) {
      return serviceMocks.verify(challengeId, credential);
    }
  }
}));

import {
  handleBeginPasskeySignIn,
  handleVerifyPasskeySignIn
} from "@/lib/auth/sign-in-http";

function configureEnv() {
  process.env.GETDONE_RUNTIME_ENV = "production";
  process.env.GETDONE_WEBAUTHN_RP_ID = "getdone.test";
  process.env.GETDONE_WEBAUTHN_ORIGINS = "https://app.getdone.test";
  process.env.GETDONE_AUTH_COOKIE_NAME = "getdone_session";
  process.env.GETDONE_STEP_UP_TTL_SECONDS = "300";
  process.env.GETDONE_SIGN_IN_CHALLENGE_TTL_SECONDS = "300";
  process.env.GETDONE_SESSION_TTL_SECONDS = "3600";
}

async function body(response: Response) {
  return await response.json() as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
}

describe("passkey sign-in HTTP handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureEnv();
  });

  it("begins passkey sign-in and never caches the challenge response", async () => {
    serviceMocks.begin.mockResolvedValue({
      challengeId: "18d7d41f-90d9-468b-b95d-5e898f3fb392",
      expiresAt: "2099-01-01T00:00:00.000Z",
      method: "passkey",
      challenge: "challenge-value",
      rpId: "getdone.test",
      allowCredentialIds: ["Y3JlZC0x"],
      userVerification: "required"
    });

    const response = await handleBeginPasskeySignIn(new Request(
      "https://app.getdone.test/api/control/auth/sign-in/begin",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "owner-a" })
      }
    ));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(serviceMocks.begin).toHaveBeenCalledWith("owner-a");
    expect((await body(response)).data).toMatchObject({
      method: "passkey",
      rpId: "getdone.test"
    });
  });

  it("rejects malformed and invalid begin payloads", async () => {
    const malformed = await handleBeginPasskeySignIn(new Request(
      "https://app.getdone.test/api/control/auth/sign-in/begin",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{"
      }
    ));
    expect(malformed.status).toBe(400);
    expect((await body(malformed)).error?.code).toBe("VALIDATION_FAILED");

    const invalid = await handleBeginPasskeySignIn(new Request(
      "https://app.getdone.test/api/control/auth/sign-in/begin",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "" })
      }
    ));
    expect(invalid.status).toBe(400);
    expect(serviceMocks.begin).not.toHaveBeenCalled();
  });

  it("normalizes authentication failures from the sign-in service", async () => {
    serviceMocks.begin.mockRejectedValue(
      new ControlPlaneError("UNAUTHENTICATED", "Passkey sign-in is unavailable")
    );
    const response = await handleBeginPasskeySignIn(new Request(
      "https://app.getdone.test/api/control/auth/sign-in/begin",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "owner-a" })
      }
    ));
    expect(response.status).toBe(401);
    expect((await body(response)).error).toMatchObject({
      code: "UNAUTHENTICATED",
      message: "Passkey sign-in is unavailable"
    });
  });

  it("verifies a passkey, returns only session metadata, and sets a hardened cookie", async () => {
    serviceMocks.verify.mockResolvedValue({
      session: {
        sessionId: "session-a",
        userId: "owner-a",
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        authenticatedAt: new Date().toISOString()
      },
      token: "opaque-session-token"
    });

    const credential = {
      id: "Y3JlZC0x",
      type: "public-key",
      response: {
        clientDataJSON: "Y2xpZW50",
        authenticatorData: "YXV0aA",
        signature: "c2ln",
        userHandle: null
      }
    };
    const response = await handleVerifyPasskeySignIn(new Request(
      "https://app.getdone.test/api/control/auth/sign-in/verify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: "18d7d41f-90d9-468b-b95d-5e898f3fb392",
          credential
        })
      }
    ));

    expect(response.status).toBe(200);
    expect(serviceMocks.verify).toHaveBeenCalledWith(
      "18d7d41f-90d9-468b-b95d-5e898f3fb392",
      credential
    );
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("getdone_session=opaque-session-token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toMatch(/Max-Age=\d+/);

    const payload = await body(response);
    expect(payload.data).toMatchObject({
      sessionId: "session-a",
      userId: "owner-a"
    });
    expect(JSON.stringify(payload)).not.toContain("opaque-session-token");
  });

  it("rejects invalid verification payloads before invoking the verifier", async () => {
    const response = await handleVerifyPasskeySignIn(new Request(
      "https://app.getdone.test/api/control/auth/sign-in/verify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: "not-a-uuid",
          credential: {}
        })
      }
    ));
    expect(response.status).toBe(400);
    expect(serviceMocks.verify).not.toHaveBeenCalled();
  });
});
