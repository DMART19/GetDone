import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage/vitest",
      reporter: ["text", "json-summary", "html"],
      include: ["lib/**/*.ts"],
      exclude: [
        "lib/**/*.test.ts",
        "lib/**/test-fixture.ts",
        "lib/**/test-security-fixture.ts",
        "lib/mock-data.ts",
        "lib/**/development-mock-*.ts"
      ],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 75,
        lines: 80
      }
    }
  }
});
