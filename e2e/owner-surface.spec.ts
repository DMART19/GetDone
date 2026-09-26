import { expect, test } from "@playwright/test";

test.describe("existing owner surface", () => {
  test("primary Chat / Decisions / Resources navigation stays usable", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: /How can I/i })).toBeVisible();\n    await expect(page.getByRole("link", { name: "Production acceptance" })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Primary navigation" });
    await expect(nav.getByRole("link", { name: "Chat" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Decisions" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Resources" })).toBeVisible();

    await nav.getByRole("link", { name: "Decisions" }).click();
    await expect(page.getByRole("heading", { name: /Decisions/ })).toBeVisible();
    await expect(page.getByText("Approve resource addition")).toBeVisible();

    await page.getByRole("navigation", { name: "Primary navigation" })
      .getByRole("link", { name: "Resources" }).click();
    await expect(page.getByRole("heading", { name: /Resources/ })).toBeVisible();
    await expect(page.getByText("Home Pi")).toBeVisible();

    await page.getByRole("link", { name: /Add Resource/i }).click();
    await expect(page.getByRole("heading", { name: "What would you like to add?" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Cancel" })).toHaveAttribute("href", "/resources");
  });

  test("direct decision and resource deep links resolve to scoped detail views", async ({ page }) => {
    await page.goto("/decisions/approve-dc-west");
    await expect(page.getByRole("heading", { name: "Approve resource addition" })).toBeVisible();
    await expect(page.getByText(/No server-side approval or side effect occurs/i)).toBeVisible();

    await page.goto("/resources/home-pi?incident=preview-incident");
    await expect(page.getByRole("heading", { name: /Home Pi/ })).toBeVisible();
    await expect(page.getByText(/Compute · Lightweight/)).toBeVisible();

    await page.goto("/decisions/approve-dc-west?resource=home-pi");
    await expect(page.getByRole("heading", { name: "Approve resource addition" })).toBeVisible();
  });

  test("unknown scoped resources and decisions fail closed to Not found", async ({ page }) => {
    await page.goto("/decisions/not-a-real-decision");
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
    await expect(page.getByText(/not available in the current GetDone scope/i)).toBeVisible();

    await page.goto("/resources/not-a-real-resource");
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  });

  test("development API envelopes expose only development seed reads", async ({ request }) => {
    const health = await request.get("/api/health");
    expect(health.ok()).toBeTruthy();
    const healthBody = await health.json();
    expect(healthBody).toMatchObject({
      ok: true,
      environment: "development",
      data: {
        service: "getdone-web",
        status: "ok",
        authoritativeControlPlane: false,
        authProviderConnected: false,
        persistenceConnected: false,
        aiGatewayConnected: false,
        durableJobEngineConnected: false
      }
    });

    const resources = await request.get("/api/dev/resources");
    expect(resources.ok()).toBeTruthy();
    const resourceBody = await resources.json();
    expect(resourceBody.ok).toBe(true);
    expect(resourceBody.environment).toBe("development");
    expect(resourceBody.data.some((item: { id: string }) => item.id === "home-pi")).toBe(true);

    const decisions = await request.get("/api/dev/decisions");
    expect(decisions.ok()).toBeTruthy();
    const decisionBody = await decisions.json();
    expect(decisionBody.ok).toBe(true);
    expect(decisionBody.data.some((item: { id: string }) => item.id === "approve-dc-west")).toBe(true);

    const controlHealth = await request.get("/api/control/health");
    expect(controlHealth.ok()).toBeTruthy();
    expect(await controlHealth.json()).toMatchObject({
      ok: true,
      environment: "development",
      data: {
        service: "getdone-control-api",
        surfaceVersion: "1.2.0",
        status: "unavailable",
        authConnected: false,
        persistenceConnected: false
      }
    });

    const protectedControlRead = await request.get("/api/control/decisions");
    expect(protectedControlRead.status()).toBe(503);
    expect(await protectedControlRead.json()).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" }
    });
  });

  test("chat and decision controls remain preview-only", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Message GetDone").fill("Check the current resource state");
    await page.getByRole("button", { name: "Send preview message" }).click();
    await expect(page.getByRole("status")).toContainText("Queued locally for preview");

    await page.goto("/decisions/approve-dc-west");
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/Development preview status:/)).toContainText("approved");
    await expect(page.getByText(/No server-side approval or side effect occurs/i)).toBeVisible();
  });
  test("production acceptance surface exposes evidence-backed promotion state", async ({ page }) => {
    await page.goto("/operations/production-acceptance");
    await expect(page.getByRole("heading", { name: "Production acceptance" })).toBeVisible();
    await expect(page.getByText(/Production promotion/i)).toBeVisible();
    await expect(page.getByText(/Live staging deployment and rollback/i)).toBeVisible();
  });

});
