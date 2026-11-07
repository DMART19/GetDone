import { expect, test } from "@playwright/test";

test("the home solar system opens the selected business", async ({ page }) => {
  const business = { id: "business-a", portfolioId: "portfolio-a", name: "Fixture Operations" };
  await page.route("**/api/businesses", route =>
    route.fulfill({ json: { ok: true, data: [business] } })
  );
  await page.route("**/api/businesses?portfolioId=portfolio-a", route =>
    route.fulfill({ json: { ok: true, data: {
      business,
      sections: {
        objectives: { records: [{ id: "objective-a", title: "Fixture inventory review", status: "active", updatedAt: "2026-01-01T00:00:00Z" }] },
        integrations: { records: [] },
        signals: { records: [] },
        decisions: { records: [] },
        jobs: { records: [] },
        outcomes: { records: [] }
      }
    } } })
  );

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "One intelligence. Your businesses." })).toBeVisible();
  const planet = page.getByRole("button", { name: "Open Fixture Operations" });
  await planet.click();
  await expect(planet).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Fixture inventory review")).toBeVisible();
});
