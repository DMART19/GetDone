import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Exercise the actual shell control flow with deterministic external commands.
// The database integration check separately exercises the verified TLS probe.
function runSetup(successAt: number) {
  const dir = mkdtempSync(path.join(tmpdir(), "getdone-tls-retry-"));
  const script = path.resolve("scripts/configure-ci-postgres-tls.sh");
  function executable(name: string, content: string) {
    writeFileSync(path.join(dir, name), `#!/bin/bash\nset -eu\n${content}\n`, { mode: 0o700 });
  }
  try {
    executable("docker", 'printf "%s\\n" "$*" >> "$RUNNER_TEMP/docker-calls"');
    executable("openssl", 'while (( $# )); do case "$1" in -keyout|-out) touch "$2"; shift 2;; *) shift;; esac; done');
    executable("sleep", 'printf "%s\\n" "$*" >> "$RUNNER_TEMP/sleeps"');
    executable("node", `cat > "$RUNNER_TEMP/probe.js"
count=0
if [[ -f "$RUNNER_TEMP/attempts" ]]; then read -r count < "$RUNNER_TEMP/attempts"; fi
count=$((count+1))
printf '%s\\n' "$count" > "$RUNNER_TEMP/attempts"
[[ "$count" -ge "${successAt}" ]]`);
    const result = spawnSync("bash", [script, "a".repeat(64)], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_ENV: path.join(dir, "env") },
      encoding: "utf8", timeout: 30_000
    });
    return {
      status: result.status, error: result.stderr,
      attempts: Number(readFileSync(path.join(dir, "attempts"), "utf8")),
      env: readFileSync(path.join(dir, "env"), "utf8"),
      probe: readFileSync(path.join(dir, "probe.js"), "utf8"),
      calls: readFileSync(path.join(dir, "docker-calls"), "utf8")
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("CI PostgreSQL TLS readiness", () => {
  it("succeeds immediately once certificate-verified TLS is available", () => {
    const result = runSetup(1);
    expect(result.status).toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.calls).toContain("SELECT pg_reload_conf()");
    expect(result.env).toContain("PGSSLMODE=verify-full");
    expect(result.probe).toContain("rejectUnauthorized:true");
    expect(result.probe).toContain("connectionTimeoutMillis:1000");
    expect(result.probe).toContain("query_timeout:1000");
  });
  it("retries transient post-reload failures and stops on success", () => {
    const result = runSetup(3);
    expect(result.status).toBe(0);
    expect(result.attempts).toBe(3);
  });
  it("fails setup after bounded retries instead of continuing without TLS", () => {
    const result = runSetup(11);
    expect(result.status).toBe(1);
    expect(result.attempts).toBe(10);
    expect(result.error).toContain("verification failed after 10 attempts");
  });
});
