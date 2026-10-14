import { test, expect } from "@playwright/test";

// Browser smoke test of David Edition's real pages. Mutation tests are intentionally
// separate: they require an owner-authenticated staging environment and explicit opt-in.
test.describe("David Edition read-only acceptance", () => {
  test("signed-out sessions cannot see the owner decision queue", async ({ page }) => {
    await page.goto("/decisions");
    await expect(page.getByText(/AUTHENTICATED GETDONE DECISIONS/i)).toHaveCount(0);
    const href = page.url();
    expect(href.includes("/sign-in") || href.includes("/decisions")).toBeTruthy();
    if (href.includes("/decisions")) {
      await expect(page.getByRole("heading", { name: /decisions need you|decision needs you|queue is clear/i })).toHaveCount(0);
    }
  });
});

test.describe("David Edition authenticated acceptance", () => {
  test.skip(!process.env.GETDONE_E2E_OWNER_STORAGE_STATE, "Requires real staging owner session.");
  test.use({ storageState: process.env.GETDONE_E2E_OWNER_STORAGE_STATE || undefined });
  test("sign in state, business catalog, decision and resource routing", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("DAVID EDITION", { exact: false }).first()).toBeVisible();
    await page.getByRole("link", { name: /decisions/i }).first().click();
    await expect(page.getByRole("region", { name: /David Edition owner decision bridge/i })).toBeVisible();
    await page.getByRole("button", { name: /show evidence & related systems/i }).first().click().catch(() => {});
    await page.getByRole("link", { name: /resources/i }).first().click();
    await expect(page.getByText(/resources/i).first()).toBeVisible();
    const response = await page.request.get("/api/universe/overview", { failOnStatusCode: false });
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.data?.businesses)).toBe(true);
    for (const business of data.data.businesses) {
      expect(business.health).toBe("Unknown");
      expect(business.resources.every((r: { health: string }) => r.health === "Unknown")).toBe(true);
    }
  });
});

// No production mutation is automated. Governed approval acceptance must be
// explicitly opted into a staging environment with a disposable decision ID.
test.describe("governed staging decision approval", () => {
  test.skip(process.env.GETDONE_E2E_MUTATION_ALLOWED !== "staging" ||
    !process.env.GETDONE_E2E_OWNER_STORAGE_STATE ||
    !process.env.GETDONE_E2E_DECISION_ID,
    "Requires explicit staging approval opt-in, disposable decision and owner session.");
  test.use({ storageState: process.env.GETDONE_E2E_OWNER_STORAGE_STATE || undefined });
  test("approval uses the existing decision route and observes persisted status", async ({ page }) => {
    const id = process.env.GETDONE_E2E_DECISION_ID!;
    const before = await page.request.get("/api/control/decisions/" + encodeURIComponent(id));
    expect(before.ok()).toBeTruthy();
    const beforeJson = await before.json();
    expect(beforeJson.data?.status).toBe("pending");
    await page.goto("/decisions/" + encodeURIComponent(id));
    await page.getByRole("button", { name: /^Approve$/ }).click();
    await expect(page.getByText(/Authoritative status: approved/i)).toBeVisible({ timeout: 20000 });
    const after = await page.request.get("/api/control/decisions/" + encodeURIComponent(id));
    expect(after.ok()).toBeTruthy();
    expect((await after.json()).data?.status).toBe("approved");
    // This verifies persisted approval, NOT worker execution or objective completion.
  });
});
