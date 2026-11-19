import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page) {
  const business = { id: "fixture-company", portfolioId: "fixture-portfolio", name: "Fixture Orbit" };
  let status = 200;
  await page.route("**/api/businesses**", route => {
    if (!new URL(route.request().url()).searchParams.has("portfolioId")) {
      return route.fulfill({ json: { ok: true, data: [business] } });
    }
    if (status !== 200) return route.fulfill({ status, json: { ok: false } });
    const sections = Object.fromEntries(["objectives", "integrations", "signals", "decisions", "jobs", "outcomes"].map(section => [section, {
      records: section === "objectives" ? [{ id: "fixture-objective", title: "Private fixture objective", status: "active", updatedAt: "2026-11-01T00:00:00Z" }] : []
    }]));
    return route.fulfill({ json: { ok: true, data: { business, sections } } });
  });
  await page.goto("/");
  const planet = page.getByRole("button", { name: "Inspect Fixture Orbit" });
  await expect(planet).toBeVisible();
  return { planet, setStatus: (value: number) => { status = value; } };
}

for (const status of [401, 403]) {
  test(`clears cached business records after ${status} on refresh`, async ({ page }) => {
    const { planet, setStatus } = await fixture(page);
    await planet.click();
    await expect(page.getByText("Private fixture objective", { exact: true })).toBeVisible();
    setStatus(status);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText(status === 401 ? "Your session has expired. Sign in again." : "You do not have access to this business information.")).toBeVisible();
    await expect(page.getByText("Private fixture objective", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Business capability map" })).toHaveCount(0);
  });
}

test("retains the last snapshot during a transient outage and recovers", async ({ page }) => {
  const { planet, setStatus } = await fixture(page);
  await planet.click();
  await expect(page.getByText("Private fixture objective", { exact: true })).toBeVisible();
  setStatus(503);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Connection interrupted · showing last confirmed records")).toBeVisible();
  await expect(page.getByText("Private fixture objective", { exact: true })).toBeVisible();
  setStatus(200);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText(/Last synchronized/)).toBeVisible();
});

test("reduced-motion canvas survives viewport resizing", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page);
  await expect(page.getByRole("button", { name: "Resume space animation" })).toBeVisible();
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: viewport.width - 15, height: viewport.height - 20 });
  await expect.poll(() => page.locator("canvas.de-cosmos-canvas").evaluate((element: HTMLCanvasElement) => {
    const pixel = element.getContext("2d")!.getImageData(0, 0, 1, 1).data;
    return pixel[0] + pixel[1] + pixel[2];
  })).toBeGreaterThan(0);
});

test("business controls remain usable without canvas rendering", async ({ page }) => {
  await page.addInitScript(() => { HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext; });
  const { planet } = await fixture(page);
  await planet.click();
  await expect(page.getByText("Private fixture objective", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close business context" }).click();
  await expect(planet).toBeFocused();
});


test("logout reports server failure and only redirects after successful revocation", async ({ page }) => {
  let succeeds = false;
  await page.route("**/api/control/auth/logout", route => {
    expect(route.request().method()).toBe("POST");
    return route.fulfill({ status: succeeds ? 200 : 503, json: { ok: succeeds } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByText("Could not sign out. Please retry.")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  succeeds = true;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});
