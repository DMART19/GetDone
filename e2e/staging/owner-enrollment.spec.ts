import { createHash, randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { pool, resetAuthoritativeStaging, seedPasskeyOwner, STAGING_USER_ID } from "./support";

test("owner invitation → device-created passkey → real sign-in → no invitation replay", async ({ page, baseURL }) => {
  await resetAuthoritativeStaging();
  await seedPasskeyOwner();
  const db = pool();
  const token = randomBytes(32).toString("base64url");
  try {
    // Existing helper provisions memberships. Remove its pre-generated key so
    // this scenario must create a new key through the real browser ceremony.
    await db.query("DELETE FROM auth_webauthn_credentials WHERE user_id=$1", [STAGING_USER_ID]);
    await db.query(`INSERT INTO auth_owner_enrollments
      (user_id,token_hash,environment,rp_id,allowed_origins,user_handle,expires_at)
      VALUES($1,$2,'staging','localhost',$3::jsonb,$4,now()+interval '10 minutes')`,
    [STAGING_USER_ID, createHash("sha256").update(token).digest("hex"), JSON.stringify([baseURL]), Buffer.from(STAGING_USER_ID).toString("base64url")]);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true
    }});
    try {
      await page.goto(`/setup/owner#${token}`);
      await expect(page).toHaveURL(/\/setup\/owner$/);
      await page.getByRole("button", { name: "Create owner passkey" }).click();
      await expect(page.getByRole("status")).toContainText("Your passkey is ready");
      await page.getByRole("link", { name: "Sign in with your passkey" }).click();
      await page.getByLabel("GetDone user").fill(STAGING_USER_ID);
      await page.getByRole("button", { name: "Sign in with passkey" }).click();
      await expect(page).toHaveURL("/");
      await expect(page.getByRole("heading", { name: "What do you want done?" })).toBeVisible();
      const replay = await page.evaluate(async invitation => {
        const response = await fetch("/api/control/auth/enrollment/begin", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: invitation })
        });
        return response.status;
      }, token);
      expect(replay).toBe(403);
      expect((await db.query("SELECT credential_id FROM auth_webauthn_credentials WHERE user_id=$1", [STAGING_USER_ID])).rowCount).toBe(1);
    } finally { await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }); await cdp.detach(); }
  } finally { await db.end(); }
});
