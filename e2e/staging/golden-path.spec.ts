import { expect, test } from "@playwright/test";
import {
  STAGING_USER_ID,
  createTaskJobAndExecute,
  decisionStatus,
  installVirtualAuthenticator,
  materializeDecisionFromIntent,
  resetAuthoritativeStaging,
  seedPasskeyOwner
} from "./support";

test.describe("authoritative staging browser golden path", () => {
  test("sign in → intent → Decision → approval → Task/Job → safe integration → verified completion", async ({ page, baseURL }) => {
    await resetAuthoritativeStaging();
    const passkey = await seedPasskeyOwner();

    await page.goto("/sign-in");
    await installVirtualAuthenticator(page, passkey);

    await page.getByLabel("GetDone user").fill(STAGING_USER_ID);
    await page.getByRole("button", { name: "Sign in with passkey" }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: "What do you want done?" })).toBeVisible();

    // Wait for the authoritative Home Objective Inbox to hydrate before submitting.
    await page.waitForLoadState("networkidle");

    await page.getByLabel("Objective input").fill(
      "Run the controlled safe staging integration and show me the verified result"
    );
    const [intentResponse] = await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes("/api/control/objectives")
        && response.request().method() === "POST"
      ),
      page.getByRole("button", { name: "Add Objective" }).click()
    ]);
    expect(intentResponse.status()).toBe(201);
    await expect(page.getByRole("status")).toContainText("Objective added. GetDone is taking it from here.");
    const objectiveResponse = await intentResponse.json() as {
      ok: boolean;
      data: Array<{ correlationId: string }>;
    };
    expect(objectiveResponse.ok).toBe(true);
    const correlationId = objectiveResponse.data[0]?.correlationId;
    expect(correlationId).toBeTruthy();
    if (!correlationId) throw new Error("Objective response did not include correlationId");
    const decision = await materializeDecisionFromIntent(correlationId);

    await page.goto("/decisions");
    await expect(page.getByText("Approve safe staging integration")).toBeVisible();
    const decisionCard = page.getByRole("article").filter({ hasText: "Approve safe staging integration" });
    const [approvalResponse] = await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes(`/api/control/decisions/${decision.id}`)
        && response.request().method() === "PATCH"
        && response.status() === 200
      ),
      decisionCard.getByRole("button", { name: "Approve" }).click()
    ]);
    expect(approvalResponse.status()).toBe(200);
    await expect.poll(async () => (await decisionStatus())?.status).toBe("approved");

    const execution = await createTaskJobAndExecute(
      correlationId,
      baseURL ?? "http://localhost:3200"
    );

    await page.goto(`/operations/jobs/${execution.jobId}`);
    await expect(page.getByRole("heading", { name: "Authoritative completion" })).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("Completed and verified");
    await expect(page.getByText(/Verified · 1 evidence item/)).toBeVisible();
    await expect(page.getByTestId("job-correlation-id")).toHaveText(correlationId);

    const jobResponse = await page.evaluate(async (jobId) => {
      const response = await fetch(`/api/control/jobs/${encodeURIComponent(jobId)}/result`, {
        cache: "no-store",
        credentials: "same-origin"
      });
      return { status: response.status, body: await response.json() };
    }, execution.jobId);

    expect(jobResponse.status).toBe(200);
    expect(jobResponse.body).toMatchObject({
      ok: true,
      environment: "staging",
      data: {
        jobId: execution.jobId,
        state: "verified",
        correlationId: correlationId,
        verificationReceiptId: execution.receiptId
      }
    });
  });
});
