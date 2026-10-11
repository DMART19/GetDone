import { expect, test } from "@playwright/test";

test("restores messages and shows governed approval through verified completion", async ({ page }) => {
  const threadId = "00000000-0000-4000-8000-000000000001";
  let approved = false;
  const headers: Record<string, string>[] = [];
  await page.route("**/api/control/chat*", async route => {
    const record = { id: "intent", threadId, companyId: "c", portfolioId: "p", userId: "u", message: "Prepare the campaign draft", receivedAt: "2026-10-11T20:00:00Z" };
    await route.fulfill({ json: { ok: true, data: {
      threadId, businesses: [{ id: "c", portfolioId: "p", name: "Acme" }], state: { activeBusiness: { id: "c", portfolioId: "p", name: "Acme" } },
      turns: [{ record, status: {
        intentId: "intent", lifecycle: approved ? { state: "verified", label: "Verified complete", terminal: true, verified: true }
          : { state: "awaiting_approval", label: "Waiting for your approval", terminal: false, verified: false },
        verificationRefs: approved ? ["receipt:campaign-draft"] : [],
        decisions: [{ id: "decision", status: approved ? "approved" : "pending", stepId: "draft-step", requiresStepUp: false,
          summary: { title: "Create a campaign draft", expectedOutcome: "A draft saved without publishing", estimatedCostCents: 0, risk: "low", verification: ["Confirm draft status"] } }]
      } }]
    } } });
  });
  await page.route("**/api/control/decisions/decision", async route => {
    expect(route.request().method()).toBe("PATCH");
    expect(route.request().postDataJSON()).toEqual({ action: "approve" });
    headers.push(route.request().headers());
    approved = true;
    await route.fulfill({ json: { ok: true, data: { status: "approved" } } });
  });
  await page.goto("/");
  await expect(page.getByRole("log")).toContainText("Prepare the campaign draft");
  await expect(page.getByRole("log")).toContainText("A draft saved without publishing");
  await page.reload();
  await expect(page.getByRole("log")).toContainText("Prepare the campaign draft");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("log")).toContainText("Verified complete");
  await expect(page.getByRole("log")).toContainText("receipt:campaign-draft");
  expect(headers[0]["x-getdone-portfolio-id"]).toBe("p");
  expect(headers[0]["idempotency-key"]).toBeTruthy();
});

test("failed loading retains a retry path and does not invent conversation history", async ({ page }) => {
  await page.route("**/api/control/chat*", route => route.fulfill({ status: 503, json: { ok: false, error: { message: "Conversation unavailable" } } }));
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Conversation unavailable");
  await expect(page.getByRole("button", { name: "Retry loading" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
});
