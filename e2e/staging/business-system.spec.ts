import { randomBytes } from "node:crypto";
import { sha256Hex } from "../../lib/control-plane/canonical-hash";
import { expect, test, type Page } from "@playwright/test";
import { pool, resetAuthoritativeStaging, seedPasskeyOwner } from "./support";

async function seed(page: Page) {
  await resetAuthoritativeStaging();
  await seedPasskeyOwner();
  const token = randomBytes(32).toString("hex");
  const db = pool();
  try {
    await db.query("UPDATE companies SET name='OpsManagerPro' WHERE id='company-browser'");
    await db.query("INSERT INTO companies(id,organization_id,name) VALUES('company-status','org-browser','StatusWatchPro'),('company-private','org-browser','Private Business')");
    await db.query("INSERT INTO portfolios(id,organization_id,company_id,name) VALUES('portfolio-status','org-browser','company-status','Status portfolio'),('portfolio-private','org-browser','company-private','Private portfolio')");
    await db.query("INSERT INTO company_memberships(user_id,company_id,role,status) VALUES('browser-owner','company-status','owner','active')");
    await db.query("INSERT INTO portfolio_memberships(user_id,portfolio_id,company_id,role,status) VALUES('browser-owner','portfolio-status','company-status','owner','active')");
    await db.query("INSERT INTO auth_sessions(session_id,user_id,token_hash,issued_at,expires_at,authenticated_at) VALUES('solar-browser','browser-owner',$1,now(),now()+interval '1 hour',now())", [sha256Hex(token)]);
    for (const [kind, title] of [["objective", "Improve Ops onboarding"], ["integration", "Ops GitHub"], ["decision", "Review Ops release"], ["job", "Ops verification"], ["outcome", "Ops verified result"]]) {
      await db.query("INSERT INTO control_plane_entities(entity_type,id,portfolio_id,company_id,version,updated_at,payload) VALUES($1,$2,'portfolio-browser','company-browser',1,now(),$3)", [kind, `solar-${kind}`, JSON.stringify({ id: `solar-${kind}`, ...(kind === "objective" || kind === "integration" ? { environment: "staging" } : {}), title, state: "recorded", metadata: { secret: "fixture-secret" } })]);
    }
  } finally { await db.end(); }
  await page.context().addCookies([{ name: "getdone_session", value: token, url: "http://localhost:3200", httpOnly: true, sameSite: "Lax" }]);
}

test("real company planets, scoped context, sections and tenant isolation", async ({ page }) => {
  await seed(page);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/");
  await expect(page.locator(".business-sun strong")).toHaveText("GetDone");
  await expect(page.getByRole("button", { name: "Open OpsManagerPro" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open StatusWatchPro" })).toBeVisible();
  await expect(page.getByText("Private Business")).toHaveCount(0);
  await page.getByRole("button", { name: "Open OpsManagerPro" }).click();
  await expect(page.getByRole("region", { name: "OpsManagerPro business context" })).toBeVisible();
  await expect(page.getByText("Improve Ops onboarding")).toBeVisible();
  for (const [section, text] of [["Integrations", "Ops GitHub"], ["Decisions", "Review Ops release"], ["Jobs", "Ops verification"], ["Recent outcomes", "Ops verified result"], ["Signals", "Signal feed unavailable."]]) {
    await page.getByRole("button", { name: section, exact: true }).click();
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Open StatusWatchPro" }).click();
  await expect(page.getByText("No objectives recorded for this business.")).toBeVisible();
  await expect(page.getByText("Improve Ops onboarding")).toHaveCount(0);
  const own = await page.request.get("/api/businesses?portfolioId=portfolio-browser");
  expect(await own.text()).not.toContain("fixture-secret");
  expect((await page.request.get("/api/businesses?portfolioId=portfolio-private")).status()).toBe(403);
  const db = pool();
  try { await db.query("UPDATE company_memberships SET status='revoked' WHERE company_id='company-status'"); } finally { await db.end(); }
  expect((await page.request.get("/api/businesses?portfolioId=portfolio-status")).status()).toBe(403);
  expect(errors).toEqual([]);
  await page.context().clearCookies();
  expect((await page.request.get("/api/businesses")).status()).toBe(401);
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("empty, loading, failure recovery, mobile and reduced motion", async ({ page }) => {
  await seed(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/businesses", async route => { await gate; await route.continue(); });
  await page.goto("/");
  await expect(page.getByText("Loading your businesses…")).toBeVisible();
  release();
  await expect(page.getByRole("button", { name: "Open OpsManagerPro" })).toBeVisible();
  await page.unroute("**/api/businesses");
  await page.getByRole("button", { name: "Open OpsManagerPro" }).click();
  await expect(page.getByText("Improve Ops onboarding")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const center = await page.locator(".business-sun").boundingBox();
  const universe = await page.locator(".business-universe").boundingBox();
  expect(Math.abs(center!.x + center!.width / 2 - universe!.x - universe!.width / 2)).toBeLessThan(2);
  await page.route("**/api/businesses?*", route => route.fulfill({ status: 503, contentType: "text/html", body: "<html>private upstream detail</html>" }));
  await page.getByRole("button", { name: "Open StatusWatchPro" }).click();
  await expect(page.getByRole("button", { name: "Retry business context" })).toBeVisible();
  await expect(page.locator(".business-system").getByRole("alert")).toContainText("Business information could not be loaded. Please retry.");
  await expect(page.getByText(/private upstream detail|Unexpected token/)).toHaveCount(0);
  await expect(page.getByText("Improve Ops onboarding")).toHaveCount(0);
  await page.unroute("**/api/businesses?*");
  await page.getByRole("button", { name: "Retry business context" }).click();
  await expect(page.getByText("No objectives recorded for this business.")).toBeVisible();
  await page.route("**/api/businesses", route => route.fulfill({ status: 200, contentType: "text/html", body: "<html>private upstream detail</html>" }));
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry businesses" })).toBeVisible();
  await expect(page.locator(".business-system").getByRole("alert")).toContainText("Business information could not be loaded. Please retry.");
  await expect(page.getByText(/private upstream detail|Unexpected token/)).toHaveCount(0);
  await page.unroute("**/api/businesses");
  await page.getByRole("button", { name: "Retry businesses" }).click();
  await expect(page.getByRole("button", { name: "Open StatusWatchPro" })).toBeVisible();
  const db = pool();
  try { await db.query("UPDATE portfolio_memberships SET status='revoked'"); } finally { await db.end(); }
  await page.reload();
  await expect(page.getByText("Your first business belongs here.")).toBeVisible();
  await page.getByText("Set up your first business", { exact: true }).click();
  await expect(page.getByRole("link", { name: "Set up your owner access" })).toBeVisible();
  await expect(page.locator(".business-planet")).toHaveCount(0);
});

test("many real businesses paginate with keyboard focus and narrow-screen labels", async ({ page }) => {
  await seed(page);
  const db = pool();
  try {
    await db.query("INSERT INTO companies(id,organization_id,name) SELECT 'extra-company-'||n,'org-browser','Business '||n||' with a longer name' FROM generate_series(1,5) n");
    await db.query("INSERT INTO portfolios(id,organization_id,company_id,name) SELECT 'extra-portfolio-'||n,'org-browser','extra-company-'||n,'Extra portfolio '||n FROM generate_series(1,5) n");
    await db.query("INSERT INTO company_memberships(user_id,company_id,role,status) SELECT 'browser-owner','extra-company-'||n,'owner','active' FROM generate_series(1,5) n");
    await db.query("INSERT INTO portfolio_memberships(user_id,portfolio_id,company_id,role,status) SELECT 'browser-owner','extra-portfolio-'||n,'extra-company-'||n,'owner','active' FROM generate_series(1,5) n");
  } finally { await db.end(); }
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  await expect(page.locator(".business-planet")).toHaveCount(6);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const planet = page.getByRole("button", { name: "Open Business 1 with a longer name" });
  await planet.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Business 1 with a longer name business context" })).toBeFocused();
  await page.getByRole("button", { name: "Close business context" }).click();
  await expect(planet).toBeFocused();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator(".business-planet")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Open StatusWatchPro" })).toBeVisible();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(planet).toBeVisible();
});
