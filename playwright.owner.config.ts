import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// UI contracts use clearly named fixture responses; this is not live acceptance.
export default defineConfig({
  ...base,
  testIgnore: ["**/staging/**"],
  testMatch: ["**/david-edition-*.spec.ts", "**/conversation.spec.ts"],
  webServer: {
    ...base.webServer,
    command: "npm run dev -- --hostname 127.0.0.1 --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    env: {
      NEXT_PUBLIC_APP_ENV: "development",
      GETDONE_RUNTIME_ENV: "development",
      GETDONE_DATA_MODE: "development-seed",
      GETDONE_DAVID_EDITION: "true"
    }
  }
});
