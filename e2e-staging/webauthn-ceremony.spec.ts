import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  STAGING_OWNER_ID,
  browserAssertion,
  createPasskeyFixture,
  currentSessionId,
  decodeBase64Url,
  encodeBase64Url,
  installVirtualPasskey,
  resetAndSeedStagingDatabase,
  signInThroughBrowser,
  sql
} from "./helpers";

interface BrowserResponse<T = unknown> {
  status: number;
  body: T;
}

async function browserJson<T = unknown>(
  page: Page,
  path: string,
  input: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<BrowserResponse<T>> {
  return page.evaluate(async ({ path, input }) => {
    const response = await fetch(path, {
      method: input.method ?? "GET",
      cache: "no-store",
      headers: {
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        ...(input.headers ?? {})
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body)
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null)
    };
  }, { path, input }) as Promise<BrowserResponse<T>>;
}

async function beginStepUp(page: Page) {
  const response = await browserJson<{
    ok: boolean;
    data: {
      challengeId: string;
      challenge: string;
      rpId: string;
      allowCredentialIds: string[];
      userVerification: "required";
    };
  }>(page, "/api/control/auth/step-up/begin", { method: "POST" });
  expect(response.status).toBe(201);
  expect(response.body.ok).toBe(true);
  return response.body.data;
}

async function verifyStepUp(page: Page, challengeId: string, credential: unknown) {
  return browserJson<{
    ok: boolean;
    error?: { code?: string; message?: string };
    data?: { stepUpAuthenticatedAt?: string };
  }>(page, "/api/control/auth/step-up/verify", {
    method: "POST",
    body: { challengeId, credential }
  });
}

async function createStrongDecision(page: Page, suffix: string) {
  const intent = await browserJson<{
    ok: boolean;
    correlationId: string;
  }>(page, "/api/control/intents", {
    method: "POST",
    headers: { "idempotency-key": `webauthn-intent-${suffix}` },
    body: { message: `WebAuthn strong decision ${suffix}`, channel: "api" }
  });
  expect(intent.status).toBe(202);
  const token = process.env.GETDONE_STAGING_ACCEPTANCE_TOKEN!;
  const decision = await browserJson<{
    ok: boolean;
    data: { id: string; correlationId: string };
  }>(page, "/api/staging/acceptance/decision", {
    method: "POST",
    headers: { "x-getdone-staging-acceptance-token": token },
    body: {
      correlationId: intent.body.correlationId,
      requiresStepUp: true
    }
  });
  expect(decision.status).toBe(201);
  return decision.body.data;
}

test.describe("real WebAuthn browser ceremony", () => {
  test("runs sign-in and step-up with a virtual authenticator and rejects adversarial ceremonies", async ({ page }) => {
    const passkey = createPasskeyFixture();
    await resetAndSeedStagingDatabase(passkey);
    await page.goto("/sign-in");
    await installVirtualPasskey(page, passkey);
    await signInThroughBrowser(page);

    const strong = await createStrongDecision(page, "complete");
    await page.goto(`/decisions/${encodeURIComponent(strong.id)}`);
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/Authoritative status:/)).toContainText("approved");

    const replayChallenge = await beginStepUp(page);
    const replayAssertion = await browserAssertion(page, replayChallenge);
    const replayFirst = await verifyStepUp(
      page,
      replayChallenge.challengeId,
      replayAssertion
    );
    expect(replayFirst.status).toBe(200);
    const replaySecond = await verifyStepUp(
      page,
      replayChallenge.challengeId,
      replayAssertion
    );
    expect(replaySecond.status).toBe(403);
    expect(replaySecond.body.error?.message).toMatch(/invalid or expired|already consumed/i);

    const originChallenge = await beginStepUp(page);
    const wrongOrigin = await browserAssertion(page, originChallenge);
    const clientData = JSON.parse(
      decodeBase64Url(wrongOrigin.response.clientDataJSON).toString("utf8")
    ) as Record<string, unknown>;
    clientData.origin = "http://wrong.localhost:3200";
    wrongOrigin.response.clientDataJSON = Buffer.from(
      JSON.stringify(clientData)
    ).toString("base64url");
    const wrongOriginResult = await verifyStepUp(
      page,
      originChallenge.challengeId,
      wrongOrigin
    );
    expect(wrongOriginResult.status).toBe(403);
    expect(wrongOriginResult.body.error?.message).toMatch(/origin/i);

    const rpChallenge = await beginStepUp(page);
    const wrongRp = await browserAssertion(page, rpChallenge);
    const authenticatorData = decodeBase64Url(wrongRp.response.authenticatorData);
    createHash("sha256").update("wrong.localhost").digest().copy(authenticatorData, 0);
    wrongRp.response.authenticatorData = encodeBase64Url(authenticatorData);
    const wrongRpResult = await verifyStepUp(page, rpChallenge.challengeId, wrongRp);
    expect(wrongRpResult.status).toBe(403);
    expect(wrongRpResult.body.error?.message).toMatch(/RP ID/i);

    const staleChallenge = await beginStepUp(page);
    await sql(
      `UPDATE auth_step_up_challenges
       SET issued_at=now() - interval '10 minutes',
           expires_at=now() - interval '1 second'
       WHERE challenge_id=$1`,
      [staleChallenge.challengeId]
    );
    const staleAssertion = await browserAssertion(page, staleChallenge);
    const staleResult = await verifyStepUp(
      page,
      staleChallenge.challengeId,
      staleAssertion
    );
    expect(staleResult.status).toBe(403);
    expect(staleResult.body.error?.message).toMatch(/invalid or expired/i);

    const credentialChallenge = await beginStepUp(page);
    const wrongCredential = await browserAssertion(page, credentialChallenge);
    wrongCredential.id = Buffer.from("not-the-authorized-credential").toString("base64url");
    const wrongCredentialResult = await verifyStepUp(
      page,
      credentialChallenge.challengeId,
      wrongCredential
    );
    expect(wrongCredentialResult.status).toBe(403);
    expect(wrongCredentialResult.body.error?.message).toMatch(/not allowed/i);

    const uvChallenge = await beginStepUp(page);
    const missingUv = await browserAssertion(page, uvChallenge);
    const uvAuthenticatorData = decodeBase64Url(missingUv.response.authenticatorData);
    uvAuthenticatorData[32] &= ~0x04;
    missingUv.response.authenticatorData = encodeBase64Url(uvAuthenticatorData);
    const missingUvResult = await verifyStepUp(page, uvChallenge.challengeId, missingUv);
    expect(missingUvResult.status).toBe(403);
    expect(missingUvResult.body.error?.message).toMatch(/user verification/i);

    const expiredStepUpDecision = await createStrongDecision(page, "expired-step-up");
    const sessionId = await currentSessionId();
    await sql(
      `UPDATE auth_sessions
       SET step_up_authenticated_at=now() - interval '10 minutes'
       WHERE session_id=$1`,
      [sessionId]
    );
    const expiredStepUp = await browserJson<{
      ok: boolean;
      error?: { message?: string };
    }>(page, `/api/control/decisions/${encodeURIComponent(expiredStepUpDecision.id)}`, {
      method: "PATCH",
      headers: { "idempotency-key": "expired-step-up-decision" },
      body: { action: "approve" }
    });
    expect(expiredStepUp.status).toBe(403);
    expect(expiredStepUp.body.error?.message).toMatch(/step-up/i);

    await sql(
      "UPDATE auth_webauthn_credentials SET sign_count=999 WHERE credential_id=$1",
      [passkey.credentialId]
    );
    const rollbackChallenge = await beginStepUp(page);
    const rollbackAssertion = await browserAssertion(page, rollbackChallenge);
    const rollbackResult = await verifyStepUp(
      page,
      rollbackChallenge.challengeId,
      rollbackAssertion
    );
    expect(rollbackResult.status).toBe(403);
    expect(rollbackResult.body.error?.message).toMatch(/counter did not advance/i);

    const revokedChallenge = await beginStepUp(page);
    const revokedAssertion = await browserAssertion(page, revokedChallenge);
    await sql(
      "UPDATE auth_sessions SET revoked_at=now() WHERE session_id=$1",
      [sessionId]
    );
    const revokedResult = await verifyStepUp(
      page,
      revokedChallenge.challengeId,
      revokedAssertion
    );
    expect(revokedResult.status).toBe(401);
    expect(revokedResult.body.error?.message).toMatch(/active session/i);

    const persisted = await sql(
      `SELECT count(*)::int AS count
       FROM auth_sessions WHERE user_id=$1`,
      [STAGING_OWNER_ID]
    );
    expect(persisted.rows[0]?.count).toBeGreaterThan(0);
  });
});
