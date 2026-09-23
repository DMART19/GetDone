import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSync, assertPostgresReadyAtStartup } = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  assertPostgresReadyAtStartup: vi.fn().mockResolvedValue(null)
}));

vi.mock("node:child_process", () => ({ execFileSync }));
vi.mock("@/lib/persistence/postgres/runtime.server", () => ({
  assertPostgresReadyAtStartup
}));

import { registerNodeInstrumentation } from "@/instrumentation.node";

describe("production startup validation hook", () => {
  const mutableEnv = process.env as Record<string, string | undefined>;
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    GETDONE_RUNTIME_ENV: process.env.GETDONE_RUNTIME_ENV,
    GETDONE_PROCESS_ROLE: process.env.GETDONE_PROCESS_ROLE
  };

  beforeEach(() => {
    execFileSync.mockReset();
    assertPostgresReadyAtStartup.mockClear();
    mutableEnv.GETDONE_PROCESS_ROLE = "web";
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete mutableEnv[key];
      else mutableEnv[key] = value;
    }
  });

  it("runs verify-production-runtime before production PostgreSQL startup inspection", async () => {
    mutableEnv.NODE_ENV = "production";
    mutableEnv.GETDONE_RUNTIME_ENV = "production";

    await registerNodeInstrumentation();

    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/scripts[\\/]verify-production-runtime\.mjs$/)],
      expect.objectContaining({
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit"
      })
    );
    expect(assertPostgresReadyAtStartup).toHaveBeenCalledTimes(1);
    expect(execFileSync.mock.invocationCallOrder[0])
      .toBeLessThan(assertPostgresReadyAtStartup.mock.invocationCallOrder[0]);
  });

  it("does not apply the production-only validator to staging", async () => {
    mutableEnv.NODE_ENV = "production";
    mutableEnv.GETDONE_RUNTIME_ENV = "staging";

    await registerNodeInstrumentation();

    expect(execFileSync).not.toHaveBeenCalled();
    expect(assertPostgresReadyAtStartup).toHaveBeenCalledTimes(1);
  });

  it("fails closed through the production validator when NODE_ENV is production but runtime identity is missing", async () => {
    mutableEnv.NODE_ENV = "production";
    delete mutableEnv.GETDONE_RUNTIME_ENV;

    await registerNodeInstrumentation();

    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(assertPostgresReadyAtStartup).toHaveBeenCalledTimes(1);
  });
});
