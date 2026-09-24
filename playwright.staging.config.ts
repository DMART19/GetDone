import { defineConfig, devices } from "@playwright/test";

const port = 3200;
const baseURL = `http://localhost:${port}`;

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for staging browser E2E`);
  return value;
}

export default defineConfig({
  testDir: "./e2e-staging",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [
        ["line"],
        ["html", { outputFolder: "playwright-report-staging", open: "never" }],
        ["json", { outputFile: "test-results/staging-playwright-results.json" }]
      ]
    : "line",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    serviceWorkers: "allow"
  },
  webServer: {
    command: `npm run start -- --hostname localhost --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_APP_ENV: "staging",
      GETDONE_RUNTIME_ENV: "staging",
      GETDONE_DATA_MODE: "authoritative",
      GETDONE_CONTROL_API_URL: baseURL,
      GETDONE_WEBAUTHN_RP_ID: "localhost",
      GETDONE_WEBAUTHN_ORIGINS: baseURL,
      GETDONE_AUTH_COOKIE_NAME: "getdone_session",
      GETDONE_SESSION_TTL_SECONDS: "3600",
      GETDONE_STEP_UP_TTL_SECONDS: "300",
      GETDONE_SIGN_IN_CHALLENGE_TTL_SECONDS: "300",
      GETDONE_STAGING_BROWSER_E2E: "true",
      GETDONE_STAGING_ACCEPTANCE_TOKEN: required("GETDONE_STAGING_ACCEPTANCE_TOKEN"),
      DATABASE_URL: required("DATABASE_URL"),
      GETDONE_DB_SSL: process.env.GETDONE_DB_SSL?.trim() || "false"
    }
  },
  projects: [{
    name: "staging-chromium",
    use: { ...devices["Desktop Chrome"] }
  }]
});
