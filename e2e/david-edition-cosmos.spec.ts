import { expect, test } from "@playwright/test";

test("David Edition keeps the real business UI and gated navigation", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".de-header")).toBeVisible();
  await expect(page.locator(".de-topnav, .de-mobile-nav").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText("DAVID EDITION / COMMAND 37")).toBeVisible();
  const businessUniverse = page.locator(".business-universe");
  const spaceScene = page.locator(".de-cosmos");
  // The cinematic scene renders only when the authenticated catalog has a business.
  if (await spaceScene.count()) {
    await expect(spaceScene).toBeVisible();
    await expect(page.getByText("AUTHENTICATED BUSINESS UNIVERSE")).toBeVisible();
    await expect(page.getByText("STATUS UNVERIFIED")).toBeVisible();
    const pause = page.getByRole("button", { name: "Pause space animation" });
    await pause.click();
    await expect(page.getByRole("button", { name: "Resume space animation" })).toBeVisible();
  } else {
    await expect(businessUniverse).toBeVisible();
  }
  await page.locator(".de-topnav a, .de-mobile-nav a").filter({ visible: true }).filter({ hasText: "Decisions" }).first().click();
  await expect(page.getByRole("region", { name: "David Edition decision command" })).toBeVisible();
  await page.locator(".de-topnav a, .de-mobile-nav a").filter({ visible: true }).filter({ hasText: "Resources" }).first().click();
  await expect(page.getByText("Resource command")).toBeVisible();
});
