import { expect, test } from "@playwright/test";

test("planet selection uses the authorized business contract and refreshes scoped records", async ({ page }) => {
  const business = { id: "company-staging-1", portfolioId: "portfolio-staging-1", name: "Staging Orbit" };
  let version = 0;
  await page.route("**/api/businesses**", async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("portfolioId")) {
      if (url.searchParams.get("portfolioId") !== business.portfolioId) {
        return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ ok: false }) });
      }
      version++;
      const sections = Object.fromEntries(
        ["objectives", "integrations", "signals", "decisions", "jobs", "outcomes"].map(key => [
          key, { records: key === "integrations"
            ? [{ id: "integration-1", title: "Staging Connector", status: version === 1 ? "unknown" : "configured", updatedAt: new Date(0).toISOString() }]
            : [], note: "Contract-only UI test" }
        ])
      );
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { business, sections } }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: [business] }) });
  });
  await page.goto("/");
  const planet = page.getByRole("button", { name: "Inspect Staging Orbit" });
  await expect(planet).toBeVisible();
  await planet.click();
  await expect(page.getByRole("region", { name: "Staging Orbit business context" })).toBeVisible();
  await expect(page.getByText("Staging Connector").first()).toBeVisible();
  await expect(page.getByText("unknown").first()).toBeVisible();
  await page.getByRole("button", { name: "Refresh records" }).click();
  await expect(page.getByText("configured").first()).toBeVisible();
  await expect(planet).toHaveAttribute("aria-pressed", "true");
});
