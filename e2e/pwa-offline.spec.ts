import { expect, test } from "@playwright/test";

test.describe("PWA, offline and browser failure behavior", () => {
  test("manifest and service worker install the minimal offline shell without API caching", async ({ page, request }) => {
    const manifest = await request.get("/manifest.webmanifest");
    expect(manifest.ok()).toBeTruthy();
    const manifestBody = await manifest.json();
    expect(manifestBody.display).toBe("standalone");
    expect(manifestBody.start_url).toBe("/");

    await page.goto("/");
    const serviceWorker = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return null;
      const registration = await navigator.serviceWorker.ready;
      return registration.active?.scriptURL ?? null;
    });
    expect(serviceWorker).toContain("/sw.js");

    const cachedPaths = await page.evaluate(async () => {
      const keys = await caches.keys();
      const paths: string[] = [];
      for (const key of keys) {
        const cache = await caches.open(key);
        const requests = await cache.keys();
        paths.push(...requests.map((entry) => new URL(entry.url).pathname));
      }
      return paths;
    });
    expect(cachedPaths).toEqual(expect.arrayContaining(["/offline", "/icon.svg"]));
    expect(cachedPaths.some((path) => path.startsWith("/api/"))).toBe(false);
  });

  test("browser offline state is visible and explicit offline route stays safe", async ({ page, context }) => {
    await page.goto("/");
    await page.evaluate(async () => {
      if ("serviceWorker" in navigator) await navigator.serviceWorker.ready;
    });

    await context.setOffline(true);
    await expect(page.getByText("Offline — showing the current local shell.")).toBeVisible();

    await context.setOffline(false);
    await page.goto("/offline");
    await expect(page.getByRole("heading", { name: "You’re offline" })).toBeVisible();
    await expect(page.getByText(/No autonomous job is modeled as browser-dependent/i)).toBeVisible();
  });

  test("a controlled offline navigation falls back to the cached offline document", async ({ page, context }) => {
    await page.goto("/");
    await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return;
      await navigator.serviceWorker.ready;
    });
    await page.reload();

    const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker?.controller));
    test.skip(!controlled, "Browser did not acquire service-worker control in this runtime");

    await context.setOffline(true);
    await page.goto("/decisions").catch(() => undefined);
    await expect(page.getByRole("heading", { name: "You’re offline" })).toBeVisible();
  });
});
