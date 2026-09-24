import { defineConfig, devices } from "@playwright/test";

const port = 3200;
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e/staging",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI
    ? [
        ["line"],
        ["html", { open: "never", outputFolder: "playwright-report-staging" }],
        ["json", { outputFile: "test-results/playwright-staging-results.json" }]
      ]
    : "line",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ignoreHTTPSErrors: true
  },
  webServer: {
    command: `npm run dev -- --hostname 0.0.0.0 --port ${port}`,
    url: baseURL + "/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_APP_ENV: "staging",
      GETDONE_RUNTIME_ENV: "staging",
      GETDONE_DATA_MODE: "authoritative",
      GETDONE_CONTROL_API_URL: baseURL,
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false",
      GETDONE_WEBAUTHN_RP_ID: "localhost",
      GETDONE_WEBAUTHN_ORIGINS: baseURL,
      GETDONE_AUTH_COOKIE_NAME: "getdone_session",
      GETDONE_AUTH_COOKIE_SECURE: "false",
      GETDONE_SESSION_TTL_SECONDS: process.env.GETDONE_SESSION_TTL_SECONDS ?? "3600",
      GETDONE_SIGN_IN_CHALLENGE_TTL_SECONDS:
        process.env.GETDONE_SIGN_IN_CHALLENGE_TTL_SECONDS ?? "300",
      GETDONE_STEP_UP_TTL_SECONDS: process.env.GETDONE_STEP_UP_TTL_SECONDS ?? "300"
    }
  },
  projects: [
    {
      name: "staging-authoritative-chromium"
    }
  ]
});
