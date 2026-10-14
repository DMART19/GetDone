import { expect, test } from "@playwright/test";

// Run only against a fully configured, authoritative staging database.
// No mocked owner session or seeded approval can satisfy this security gate.
test("business catalog and scoped business context require owner authorization", async ({ request }) => {
  const catalog = await request.get("/api/businesses", { failOnStatusCode: false });
  expect([401, 403]).toContain(catalog.status());
  expect(catalog.headers()["cache-control"]).toContain("no-store");

  const scoped = await request.get("/api/businesses?portfolioId=00000000-0000-0000-0000-000000000000", {
    failOnStatusCode: false
  });
  expect([401, 403]).toContain(scoped.status());
  expect(scoped.headers()["cache-control"]).toContain("no-store");
});

test("decision mutation cannot be performed without an owner session", async ({ request }) => {
  const response = await request.patch("/api/control/decisions/00000000-0000-0000-0000-000000000000", {
    data: { action: "approve" },
    headers: { "idempotency-key": "staging-anonymous-auth-check" },
    failOnStatusCode: false
  });
  expect([401, 403]).toContain(response.status());
});

test("unauthenticated owner conversation history is never disclosed across portfolios", async ({ request }) => {
  for (const portfolioId of ["00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000001"]) {
    const response = await request.get("/api/control/chat", {
      headers: { "x-getdone-portfolio-id": portfolioId },
      failOnStatusCode: false
    });
    expect([401, 403]).toContain(response.status());
    expect(response.headers()["cache-control"]).toContain("no-store");
  }
});
