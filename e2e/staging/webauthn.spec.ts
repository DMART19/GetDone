import { createHash, randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  STAGING_USER_ID,
  browserAssertion,
  expireLatestChallenge,
  expireLatestStepUpProof,
  installVirtualAuthenticator,
  insertAdditionalSession,
  materializeDecisionFromIntent,
  postJson,
  resetAuthoritativeStaging,
  revokeLatestSession,
  seedPasskeyOwner,
  setCredentialSignCount
} from "./support";

type Challenge = {
  challengeId: string;
  challenge: string;
  rpId: string;
  allowCredentialIds: readonly string[];
  userVerification: "required";
  expiresAt: string;
};

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
};

type Assertion = Awaited<ReturnType<typeof browserAssertion>>;

function decode(value: string) {
  return Buffer.from(value, "base64url");
}

function encode(value: Buffer) {
  return value.toString("base64url");
}

async function beginSignIn(page: Page) {
  const response = await postJson<Envelope<Challenge>>(
    page,
    "/api/control/auth/sign-in/begin",
    { userId: STAGING_USER_ID }
  );
  expect(response.status).toBe(201);
  expect(response.value.ok).toBe(true);
  if (!response.value.data) throw new Error("Sign-in challenge missing");
  const credential = await browserAssertion(page, response.value.data);
  return { challenge: response.value.data, credential };
}

async function verifySignIn(
  page: Page,
  challengeId: string,
  credential: Assertion
) {
  return postJson<Envelope<{ sessionId: string; expiresAt: string }>>(
    page,
    "/api/control/auth/sign-in/verify",
    { challengeId, credential }
  );
}

async function signIn(page: Page) {
  const value = await beginSignIn(page);
  const verified = await verifySignIn(
    page,
    value.challenge.challengeId,
    value.credential
  );
  expect(verified.status).toBe(200);
  expect(verified.value.ok).toBe(true);
  return value;
}

async function beginStepUp(page: Page) {
  const response = await postJson<Envelope<Challenge>>(
    page,
    "/api/control/auth/step-up/begin"
  );
  expect(response.status).toBe(201);
  expect(response.value.ok).toBe(true);
  if (!response.value.data) throw new Error("Step-up challenge missing");
  const credential = await browserAssertion(page, response.value.data);
  return { challenge: response.value.data, credential };
}

async function verifyStepUp(
  page: Page,
  challengeId: string,
  credential: Assertion
) {
  return postJson<Envelope<{ stepUpAuthenticatedAt: string }>>(
    page,
    "/api/control/auth/step-up/verify",
    { challengeId, credential }
  );
}

async function fixture(page: Page) {
  await resetAuthoritativeStaging();
  const passkey = await seedPasskeyOwner();
  await page.goto("/sign-in");
  return {
    passkey,
    authenticator: await installVirtualAuthenticator(page, passkey)
  };
}

function mutateClientData(
  assertion: Assertion,
  mutation: (value: Record<string, unknown>) => void
): Assertion {
  const clientData = JSON.parse(
    decode(assertion.response.clientDataJSON).toString("utf8")
  ) as Record<string, unknown>;
  mutation(clientData);
  return {
    ...assertion,
    response: {
      ...assertion.response,
      clientDataJSON: encode(Buffer.from(JSON.stringify(clientData), "utf8"))
    }
  };
}

function mutateAuthenticatorData(
  assertion: Assertion,
  mutation: (value: Buffer) => void
): Assertion {
  const data = Buffer.from(decode(assertion.response.authenticatorData));
  mutation(data);
  return {
    ...assertion,
    response: {
      ...assertion.response,
      authenticatorData: encode(data)
    }
  };
}

test.describe.serial("real browser WebAuthn ceremony", () => {
  test("completes sign-in and step-up, rotates the session, and rejects challenge replay", async ({ page, request }) => {
    await fixture(page);

    const signedIn = await signIn(page);
    const oldCookie = (await page.context().cookies()).find(
      (cookie) => cookie.name === "getdone_session"
    )?.value;
    expect(oldCookie).toBeTruthy();

    const signInReplay = await verifySignIn(
      page,
      signedIn.challenge.challengeId,
      signedIn.credential
    );
    expect(signInReplay.status).toBe(403);
    expect(signInReplay.value.ok).toBe(false);

    const stepped = await beginStepUp(page);
    const verified = await verifyStepUp(
      page,
      stepped.challenge.challengeId,
      stepped.credential
    );
    expect(verified.status).toBe(200);
    expect(verified.value.ok).toBe(true);
    expect(verified.value.data?.stepUpAuthenticatedAt).toBeTruthy();

    const rotatedCookie = (await page.context().cookies()).find(
      (cookie) => cookie.name === "getdone_session"
    )?.value;
    expect(rotatedCookie).toBeTruthy();
    expect(rotatedCookie).not.toBe(oldCookie);

    const stolenOldSession = await request.get("/api/control/decisions", {
      headers: { cookie: `getdone_session=${oldCookie}` }
    });
    expect(stolenOldSession.status()).toBe(401);

    const currentSession = await page.evaluate(async () => {
      const response = await fetch("/api/control/decisions", {
        credentials: "same-origin",
        cache: "no-store"
      });
      return response.status;
    });
    expect(currentSession).toBe(200);

    const replay = await verifyStepUp(
      page,
      stepped.challenge.challengeId,
      stepped.credential
    );
    expect(replay.status).toBe(403);
    expect(replay.value.ok).toBe(false);
  });

  test("logout revokes the current session and clears the browser cookie", async ({ page }) => {
    await fixture(page);
    await signIn(page);

    const result = await postJson<Envelope<{ revoked: boolean }>>(
      page,
      "/api/control/auth/logout"
    );
    expect(result.status).toBe(200);
    expect(result.value).toMatchObject({
      ok: true,
      data: { revoked: true }
    });

    const sessionCookie = (await page.context().cookies()).find(
      (cookie) => cookie.name === "getdone_session"
    );
    expect(sessionCookie).toBeUndefined();

    const protectedStatus = await page.evaluate(async () => {
      const response = await fetch("/api/control/decisions", {
        credentials: "same-origin",
        cache: "no-store"
      });
      return response.status;
    });
    expect(protectedStatus).toBe(401);
  });

  test("fresh step-up revokes another device session but preserves the current session", async ({ page, request }) => {
    await fixture(page);
    await signIn(page);

    const beforeStepUp = await postJson<Envelope<{ revokedOtherSessions: number }>>(
      page,
      "/api/control/auth/sessions/revoke-others"
    );
    expect(beforeStepUp.status).toBe(403);

    const stepped = await beginStepUp(page);
    expect((await verifyStepUp(
      page,
      stepped.challenge.challengeId,
      stepped.credential
    )).status).toBe(200);

    const otherToken = "other-device-session-token";
    await insertAdditionalSession(otherToken);

    const revoked = await postJson<Envelope<{ revokedOtherSessions: number }>>(
      page,
      "/api/control/auth/sessions/revoke-others"
    );
    expect(revoked.status).toBe(200);
    expect(revoked.value.data?.revokedOtherSessions).toBe(1);

    const otherDevice = await request.get("/api/control/decisions", {
      headers: { cookie: `getdone_session=${otherToken}` }
    });
    expect(otherDevice.status()).toBe(401);

    const currentDevice = await page.evaluate(async () => {
      const response = await fetch("/api/control/decisions", {
        credentials: "same-origin",
        cache: "no-store"
      });
      return response.status;
    });
    expect(currentDevice).toBe(200);
  });

  test("rejects cross-origin cookie-authenticated mutations", async ({ page, request }) => {
    await fixture(page);
    await signIn(page);
    const cookie = (await page.context().cookies()).find(
      (value) => value.name === "getdone_session"
    )?.value;
    expect(cookie).toBeTruthy();

    const attack = await request.post("/api/control/chat", {
      headers: {
        cookie: `getdone_session=${cookie}`,
        origin: "https://attacker.invalid",
        "content-type": "application/json",
        "idempotency-key": "csrf-attack"
      },
      data: { message: "cross-site mutation" }
    });
    expect(attack.status()).toBe(403);
    expect(await attack.json()).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" }
    });
  });

  test("rejects wrong origin", async ({ page }) => {
    await fixture(page);
    const { challenge, credential } = await beginSignIn(page);
    const tampered = mutateClientData(credential, (value) => {
      value.origin = "https://attacker.invalid";
    });
    const result = await verifySignIn(page, challenge.challengeId, tampered);
    expect(result.status).toBe(403);
    expect(result.value.error?.message).toMatch(/origin/i);
  });

  test("rejects wrong RP ID hash", async ({ page }) => {
    await fixture(page);
    const { challenge, credential } = await beginSignIn(page);
    const tampered = mutateAuthenticatorData(credential, (value) => {
      createHash("sha256").update("wrong-rp.example").digest().copy(value, 0);
    });
    const result = await verifySignIn(page, challenge.challengeId, tampered);
    expect(result.status).toBe(403);
    expect(result.value.error?.message).toMatch(/RP ID/i);
  });

  test("rejects stale challenge", async ({ page }) => {
    await fixture(page);
    const { challenge, credential } = await beginSignIn(page);
    await expireLatestChallenge("sign-in");
    const result = await verifySignIn(page, challenge.challengeId, credential);
    expect(result.status).toBe(403);
    expect(result.value.error?.message).toMatch(/invalid or expired/i);
  });

  test("rejects wrong credential", async ({ page }) => {
    await fixture(page);
    const { challenge, credential } = await beginSignIn(page);
    const wrong: Assertion = {
      ...credential,
      id: randomBytes(32).toString("base64url")
    };
    const result = await verifySignIn(page, challenge.challengeId, wrong);
    expect(result.status).toBe(403);
    expect(result.value.error?.message).toMatch(/not allowed/i);
  });

  test("rejects signature-counter rollback", async ({ page }) => {
    await fixture(page);
    await signIn(page);
    await setCredentialSignCount(50);

    const { challenge, credential } = await beginSignIn(page);
    const rollback = mutateAuthenticatorData(credential, (value) => {
      value.writeUInt32BE(1, 33);
    });
    const result = await verifySignIn(page, challenge.challengeId, rollback);
    expect(result.status).toBe(403);
    expect(result.value.error?.message).toMatch(/counter/i);
  });

  test("rejects missing user verification", async ({ page }) => {
    await fixture(page);
    const { challenge, credential } = await beginSignIn(page);
    const noUv = mutateAuthenticatorData(credential, (value) => {
      value[32] = value[32] & ~0x04;
    });
    const result = await verifySignIn(page, challenge.challengeId, noUv);
    expect(result.status).toBe(403);
    expect(result.value.error?.message).toMatch(/user verification/i);
  });

  test("rejects step-up after session revocation", async ({ page }) => {
    await fixture(page);
    await signIn(page);
    const stepped = await beginStepUp(page);
    await revokeLatestSession();

    const result = await verifyStepUp(
      page,
      stepped.challenge.challengeId,
      stepped.credential
    );
    expect([401, 403]).toContain(result.status);
    expect(result.value.ok).toBe(false);
  });

  test("expired step-up cannot authorize a strong Decision", async ({ page }) => {
    await fixture(page);
    await signIn(page);
    const stepped = await beginStepUp(page);
    const verified = await verifyStepUp(
      page,
      stepped.challenge.challengeId,
      stepped.credential
    );
    expect(verified.status).toBe(200);

    await materializeDecisionFromIntent("corr-expired-step-up");
    await expireLatestStepUpProof();

    const result = await page.evaluate(async () => {
      const response = await fetch(
        "/api/control/decisions/decision-browser-safe-integration",
        {
          method: "PATCH",
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "expired-step-up-decision"
          },
          body: JSON.stringify({ action: "approve" })
        }
      );
      return {
        status: response.status,
        body: await response.json()
      };
    });

    expect(result.status).toBe(403);
    expect(result.body.error?.message).toMatch(/step-up/i);
  });
});
