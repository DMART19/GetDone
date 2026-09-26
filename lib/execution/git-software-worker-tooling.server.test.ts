import { afterEach, describe, expect, it } from "vitest";
import {
  createSoftwareWorkerPlan,
  type SoftwareDeploymentExecutor
} from "@/lib/execution/software-worker";
import {
  SoftwareWorkerRuntime,
  type SoftwareWorkerRuntimeRecord,
  type SoftwareWorkerRuntimeStore
} from "@/lib/execution/software-worker-runtime";
import {
  GitHubGitSoftwareWorkerTooling,
  type GitCommandRunner
} from "@/lib/execution/git-software-worker-tooling.server";

const plan = createSoftwareWorkerPlan({
  id: "git-runtime-plan",
  scope: {
    userId: "owner",
    portfolioId: "portfolio",
    companyId: "company",
    environment: "production"
  },
  repository: "DMART19/GetDone",
  baseRef: "main",
  isolatedBranch: "getdone/git-runtime-plan",
  createdAt: "2026-09-26T15:00:00Z"
});

class MemoryRuntimeStore implements SoftwareWorkerRuntimeStore {
  value: SoftwareWorkerRuntimeRecord | null = null;

  async get(id: string) {
    return this.value?.planId === id ? this.value : null;
  }

  async save(record: SoftwareWorkerRuntimeRecord, expected?: string) {
    if (this.value && expected !== this.value.runtimeHash) throw new Error("runtime CAS conflict");
    this.value = record;
  }
}

class FakeGit implements GitCommandRunner {
  readonly calls: string[] = [];

  async run(args: readonly string[]) {
    const key = args.join(" ");
    this.calls.push(key);
    if (key === "rev-parse --show-toplevel") {
      return { stdout: process.cwd() + "\n", stderr: "", exitCode: 0 };
    }
    if (key === "remote get-url origin") {
      return { stdout: "https://github.com/DMART19/GetDone.git\n", stderr: "", exitCode: 0 };
    }
    if (key === "rev-parse --verify main^{commit}") {
      return { stdout: "base-sha\n", stderr: "", exitCode: 0 };
    }
    if (key === "status --porcelain=v1") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (key.startsWith("show-ref --verify --quiet")) {
      return { stdout: "", stderr: "", exitCode: 1 };
    }
    if (key.startsWith("switch --create")) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (key === "branch --show-current") {
      return { stdout: plan.isolatedBranch + "\n", stderr: "", exitCode: 0 };
    }
    if (key === "add --all" || key.startsWith("commit -m ") || key.startsWith("push --set-upstream")) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (key === "diff --cached --binary --no-ext-diff") {
      return { stdout: "diff --git a/a.ts b/a.ts\n+change\n", stderr: "", exitCode: 0 };
    }
    if (key === "rev-parse HEAD") {
      return { stdout: "abc123def456\n", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: `unexpected git command: ${key}`, exitCode: 1 };
  }
}

afterEach(() => {
  delete process.env.GETDONE_GITHUB_TOKEN;
});

describe("GitHubGitSoftwareWorkerTooling", () => {
  it("connects the software runtime to real Git semantics, PR creation, and CI evidence while preserving production approval", async () => {
    process.env.GETDONE_GITHUB_TOKEN = "test-token";
    const git = new FakeGit();
    const requests: Array<{ url: string; method: string }> = [];

    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });

      if (url.includes("/pulls?")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/pulls") && method === "POST") {
        return new Response(JSON.stringify({
          number: 47,
          html_url: "https://github.com/DMART19/GetDone/pull/47",
          head: { sha: "abc123def456" }
        }), { status: 201 });
      }
      if (url.includes("/check-runs")) {
        return new Response(JSON.stringify({
          check_runs: [
            { id: 101, status: "completed", conclusion: "success", name: "CI / verify" }
          ]
        }), { status: 200 });
      }
      if (url.endsWith("/status")) {
        return new Response(JSON.stringify({ state: "success", statuses: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    }) as typeof fetch;

    const hookCalls: string[] = [];
    const tooling = new GitHubGitSoftwareWorkerTooling(
      {
        worktree: process.cwd(),
        staticAnalysisCommands: [["node", "-e", "process.stdout.write('static-ok')"]],
        testCommands: [["node", "-e", "process.stdout.write('test-ok')"]],
        securityCommands: [["node", "-e", "process.stdout.write('security-ok')"]],
        ciPollIntervalMs: 250,
        ciTimeoutMs: 500
      },
      {
        applyChanges: async () => { hookCalls.push("apply"); },
        preview: async () => {
          hookCalls.push("preview");
          return "preview://git-runtime-plan";
        },
        stage: async () => {
          hookCalls.push("stage");
          return "staging-deploy-1";
        },
        verifyStaging: async () => {
          hookCalls.push("verify-staging");
          return "staging-verification-1";
        }
      },
      git,
      fetchImpl,
      async () => {}
    );

    const store = new MemoryRuntimeStore();
    const deployments: SoftwareDeploymentExecutor = {
      id: "production-deployment-executor",
      version: "1.0.0",
      deploy: async () => {
        throw new Error("production deploy must not run during prepare");
      }
    };
    const runtime = new SoftwareWorkerRuntime(
      tooling,
      deployments,
      store,
      () => new Date("2026-09-26T16:00:00Z")
    );

    const prepared = await runtime.prepare(plan);

    expect(prepared.pipeline.state).toBe("awaiting-production-approval");
    expect(prepared.pipeline.productionPromotionReceiptHash).toBeUndefined();
    expect(prepared.artifacts.securityEvidenceIds).toHaveLength(3);
    expect(prepared.artifacts.securityEvidenceIds.some((id) =>
      id === "git:pr:47:abc123def456"
    )).toBe(true);
    expect(prepared.artifacts.securityEvidenceIds.some((id) =>
      id.startsWith("git:ci:")
    )).toBe(true);

    expect(git.calls).toContain("switch --create getdone/git-runtime-plan main");
    expect(git.calls).toContain("push --set-upstream origin HEAD:refs/heads/getdone/git-runtime-plan");
    expect(requests.some((request) => request.url.includes("/pulls?"))).toBe(true);
    expect(requests.some((request) => request.url.endsWith("/pulls") && request.method === "POST")).toBe(true);
    expect(requests.some((request) => request.url.includes("/check-runs"))).toBe(true);
    expect(hookCalls).toEqual(["apply", "preview", "stage", "verify-staging"]);
  });

  it("fails closed before preview/staging when GitHub CI reports failure", async () => {
    process.env.GETDONE_GITHUB_TOKEN = "test-token";
    const git = new FakeGit();
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/pulls?")) {
        return new Response(JSON.stringify([{
          number: 47,
          html_url: "https://github.com/DMART19/GetDone/pull/47",
          head: { sha: "abc123def456" }
        }]), { status: 200 });
      }
      if (url.includes("/check-runs")) {
        return new Response(JSON.stringify({
          check_runs: [
            { id: 101, status: "completed", conclusion: "failure", name: "CI / verify" }
          ]
        }), { status: 200 });
      }
      if (url.endsWith("/status")) {
        return new Response(JSON.stringify({ state: "failure", statuses: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "not found", init }), { status: 404 });
    }) as typeof fetch;

    const tooling = new GitHubGitSoftwareWorkerTooling(
      {
        worktree: process.cwd(),
        staticAnalysisCommands: [["node", "-e", "process.stdout.write('ok')"]],
        testCommands: [["node", "-e", "process.stdout.write('ok')"]],
        securityCommands: [["node", "-e", "process.stdout.write('ok')"]],
        ciPollIntervalMs: 250,
        ciTimeoutMs: 500
      },
      {
        applyChanges: async () => {},
        preview: async () => "preview",
        stage: async () => "staging",
        verifyStaging: async () => "receipt"
      },
      git,
      fetchImpl,
      async () => {}
    );

    const runtime = new SoftwareWorkerRuntime(
      tooling,
      { id: "deploy", version: "1", deploy: async () => { throw new Error("must not deploy"); } },
      new MemoryRuntimeStore(),
      () => new Date("2026-09-26T16:00:00Z")
    );

    await expect(runtime.prepare(plan)).rejects.toThrow(/CI did not verify/i);
  });
});
