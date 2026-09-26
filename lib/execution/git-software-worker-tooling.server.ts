import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { SoftwareWorkerPlan } from "@/lib/execution/software-worker";
import type { SoftwareWorkerTooling } from "@/lib/execution/software-worker-runtime";

export const GIT_SOFTWARE_WORKER_ADAPTER_VERSION = "1.0.0";

const execFileAsync = promisify(execFile);

export interface GitCommandRunner {
  run(args: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface GitSoftwareWorkerHooks {
  applyChanges(plan: SoftwareWorkerPlan, worktree: string): Promise<void>;
  preview(plan: SoftwareWorkerPlan): Promise<string>;
  stage(plan: SoftwareWorkerPlan): Promise<string>;
  verifyStaging(plan: SoftwareWorkerPlan, stagingDeploymentId: string): Promise<string>;
  rollback?(plan: SoftwareWorkerPlan, deploymentReference: string): Promise<void>;
}

export interface GitSoftwareWorkerConfig {
  worktree: string;
  remote?: string;
  tokenEnvVar?: string;
  commitMessage?: (plan: SoftwareWorkerPlan) => string;
  staticAnalysisCommands: readonly (readonly string[])[];
  testCommands: readonly (readonly string[])[];
  securityCommands: readonly (readonly string[])[];
  ciPollIntervalMs?: number;
  ciTimeoutMs?: number;
}

export interface GitHubPullRequestEvidence {
  number: number;
  url: string;
  headSha: string;
}

export interface GitHubCiEvidence {
  headSha: string;
  checkRunIds: readonly number[];
  statusContextIds: readonly string[];
  evidenceHash: string;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function parseRepository(repository: string) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);
  if (!match) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Software Git repository must be owner/name");
  }
  return { owner: match[1], repo: match[2] };
}

function normalizeRemoteUrl(value: string) {
  const trimmed = value.trim().replace(/\.git$/, "");
  const https = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(trimmed);
  if (https) return `${https[1]}/${https[2]}`;
  const ssh = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(trimmed);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  return null;
}

function evidenceId(kind: string, payload: string) {
  return `git:${kind}:${sha256(payload)}`;
}

export class NodeGitCommandRunner implements GitCommandRunner {
  async run(args: readonly string[], cwd: string) {
    try {
      const result = await execFileAsync("git", [...args], {
        cwd,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024
      });
      return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""), exitCode: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? String(error),
        exitCode: typeof failure.code === "number" ? failure.code : 1
      };
    }
  }
}

export class GitHubGitSoftwareWorkerTooling implements SoftwareWorkerTooling {
  private readonly remote: string;
  private readonly tokenEnvVar: string;
  private readonly ciPollIntervalMs: number;
  private readonly ciTimeoutMs: number;

  constructor(
    private readonly config: GitSoftwareWorkerConfig,
    private readonly hooks: GitSoftwareWorkerHooks,
    private readonly git: GitCommandRunner = new NodeGitCommandRunner(),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {
    this.remote = config.remote ?? "origin";
    this.tokenEnvVar = config.tokenEnvVar ?? "GETDONE_GITHUB_TOKEN";
    this.ciPollIntervalMs = Math.max(250, config.ciPollIntervalMs ?? 5_000);
    this.ciTimeoutMs = Math.max(this.ciPollIntervalMs, config.ciTimeoutMs ?? 15 * 60_000);
  }

  async inspect(plan: SoftwareWorkerPlan) {
    parseRepository(plan.repository);
    if (plan.baseRef.startsWith("-")) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Software Git base ref cannot begin with an option prefix");
    }
    await this.gitOk(["check-ref-format", "--branch", plan.isolatedBranch]);
    const root = await this.gitOk(["rev-parse", "--show-toplevel"]);
    if (root.trim() !== this.config.worktree) {
      throw new ControlPlaneError("FORBIDDEN", "Configured Git worktree does not match repository root");
    }
    const remoteUrl = await this.gitOk(["remote", "get-url", this.remote]);
    if (normalizeRemoteUrl(remoteUrl) !== plan.repository) {
      throw new ControlPlaneError("FORBIDDEN", "Git remote does not match the authorized repository");
    }
    await this.gitOk(["rev-parse", "--verify", "--end-of-options", `${plan.baseRef}^{commit}`]);
    const status = await this.gitOk(["status", "--porcelain=v1"]);
    if (status.trim()) {
      throw new ControlPlaneError("CONFLICT", "Software worker requires a clean worktree before branch isolation");
    }
  }

  async createBranch(plan: SoftwareWorkerPlan) {
    const existing = await this.git.run(
      ["show-ref", "--verify", "--quiet", `refs/heads/${plan.isolatedBranch}`],
      this.config.worktree
    );
    if (existing.exitCode === 0) {
      const lineage = await this.git.run(
        ["merge-base", "--is-ancestor", plan.baseRef, plan.isolatedBranch],
        this.config.worktree
      );
      if (lineage.exitCode !== 0) {
        throw new ControlPlaneError("FORBIDDEN", "Existing isolated branch is not descended from the authorized base ref");
      }
      await this.gitOk(["switch", plan.isolatedBranch]);
      return;
    }
    await this.gitOk(["switch", "--create", plan.isolatedBranch, plan.baseRef]);
  }

  async modify(plan: SoftwareWorkerPlan) {
    await this.assertCurrentBranch(plan);
    await this.hooks.applyChanges(plan, this.config.worktree);
    await this.gitOk(["add", "--all"]);
    const diff = await this.gitOk(["diff", "--cached", "--binary", "--no-ext-diff"]);
    if (!diff.trim()) {
      throw new ControlPlaneError("CONFLICT", "Software worker produced no staged changes");
    }
    const diffHash = sha256(diff);
    const message = this.config.commitMessage?.(plan) ?? `GetDone software worker: ${plan.id}`;
    await this.gitOk(["commit", "-m", message]);
    const commitSha = (await this.gitOk(["rev-parse", "HEAD"])).trim();
    await this.gitOk([
      "push",
      "--set-upstream",
      this.remote,
      `HEAD:refs/heads/${plan.isolatedBranch}`
    ]);
    return { commitSha, diffHash };
  }

  async staticAnalysis(plan: SoftwareWorkerPlan) {
    await this.assertCurrentBranch(plan);
    return this.runQualityCommands("static", this.config.staticAnalysisCommands);
  }

  async test(plan: SoftwareWorkerPlan) {
    await this.assertCurrentBranch(plan);
    return this.runQualityCommands("test", this.config.testCommands);
  }

  async securityCheck(plan: SoftwareWorkerPlan) {
    await this.assertCurrentBranch(plan);
    const localEvidence = await this.runQualityCommands("security", this.config.securityCommands);
    const pullRequest = await this.ensurePullRequest(plan);
    const ci = await this.collectCiEvidence(plan, pullRequest.headSha);
    return Object.freeze([
      ...localEvidence,
      `git:pr:${pullRequest.number}:${pullRequest.headSha}`,
      `git:ci:${ci.evidenceHash}`
    ]);
  }

  preview(plan: SoftwareWorkerPlan) {
    return this.hooks.preview(plan);
  }

  stage(plan: SoftwareWorkerPlan) {
    return this.hooks.stage(plan);
  }

  verifyStaging(plan: SoftwareWorkerPlan, stagingDeploymentId: string) {
    return this.hooks.verifyStaging(plan, stagingDeploymentId);
  }

  rollback(plan: SoftwareWorkerPlan, deploymentReference: string) {
    if (!this.hooks.rollback) {
      throw new ControlPlaneError("UNAVAILABLE", "Software rollback hook is not configured");
    }
    return this.hooks.rollback(plan, deploymentReference);
  }

  private async assertCurrentBranch(plan: SoftwareWorkerPlan) {
    const current = (await this.gitOk(["branch", "--show-current"])).trim();
    if (current !== plan.isolatedBranch) {
      throw new ControlPlaneError("FORBIDDEN", "Git operation escaped the isolated software branch");
    }
  }

  private async runQualityCommands(kind: string, commands: readonly (readonly string[])[]) {
    if (commands.length === 0) {
      throw new ControlPlaneError("UNAVAILABLE", `${kind} command set is empty`);
    }
    const ids: string[] = [];
    for (const command of commands) {
      if (command.length === 0) {
        throw new ControlPlaneError("VALIDATION_FAILED", `${kind} command cannot be empty`);
      }
      const executable = command[0];
      const args = command.slice(1);
      const result = await this.runProcess(executable, args);
      ids.push(evidenceId(kind, JSON.stringify({
        command,
        stdoutHash: sha256(result.stdout),
        stderrHash: sha256(result.stderr)
      })));
    }
    return Object.freeze(ids);
  }

  private async runProcess(executable: string, args: readonly string[]) {
    try {
      const result = await execFileAsync(executable, [...args], {
        cwd: this.config.worktree,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env }
      });
      return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      throw new ControlPlaneError("FORBIDDEN", "Software quality command failed", {
        details: {
          executable,
          stdoutHash: sha256(failure.stdout ?? ""),
          stderrHash: sha256(failure.stderr ?? String(error))
        }
      });
    }
  }

  private async ensurePullRequest(plan: SoftwareWorkerPlan): Promise<GitHubPullRequestEvidence> {
    const { owner, repo } = parseRepository(plan.repository);
    const headSha = (await this.gitOk(["rev-parse", "HEAD"])).trim();
    const query = new URLSearchParams({
      state: "open",
      head: `${owner}:${plan.isolatedBranch}`,
      base: plan.baseRef
    });
    const existing = await this.githubJson<Array<{ number: number; html_url: string; head: { sha: string } }>>(
      `/repos/${owner}/${repo}/pulls?${query.toString()}`
    );
    if (existing.length > 0) {
      const pr = existing[0];
      if (pr.head.sha !== headSha) {
        throw new ControlPlaneError("CONFLICT", "Existing pull request head does not match pushed software commit");
      }
      return { number: pr.number, url: pr.html_url, headSha };
    }
    const created = await this.githubJson<{ number: number; html_url: string; head: { sha: string } }>(
      `/repos/${owner}/${repo}/pulls`,
      {
        method: "POST",
        body: JSON.stringify({
          title: `GetDone software worker: ${plan.id}`,
          head: plan.isolatedBranch,
          base: plan.baseRef,
          body: [
            "Automated software-worker pull request.",
            "",
            `Plan: ${plan.id}`,
            `Plan hash: ${plan.planHash}`,
            "",
            "Production promotion is intentionally not performed by this pull request."
          ].join("\n")
        })
      }
    );
    if (created.head.sha !== headSha) {
      throw new ControlPlaneError("CONFLICT", "Created pull request head does not match pushed software commit");
    }
    return { number: created.number, url: created.html_url, headSha };
  }

  private async collectCiEvidence(plan: SoftwareWorkerPlan, headSha: string): Promise<GitHubCiEvidence> {
    const { owner, repo } = parseRepository(plan.repository);
    const started = Date.now();
    for (;;) {
      const checks = await this.githubJson<{
        check_runs: Array<{ id: number; status: string; conclusion: string | null; name: string }>;
      }>(`/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`);
      const statuses = await this.githubJson<{
        state: string;
        statuses: Array<{ id?: number; context: string; state: string }>;
      }>(`/repos/${owner}/${repo}/commits/${headSha}/status`);

      const hasEvidence = checks.check_runs.length > 0 || statuses.statuses.length > 0;
      const checksDone = checks.check_runs.every((item) => item.status === "completed");
      const checksPass = checks.check_runs.every((item) =>
        ["success", "neutral", "skipped"].includes(item.conclusion ?? "")
      );
      const statusesDone = statuses.statuses.every((item) =>
        ["success", "failure", "error"].includes(item.state)
      );
      const statusesPass = statuses.statuses.every((item) => item.state === "success");

      if (hasEvidence && checksDone && statusesDone) {
        if (!checksPass || !statusesPass || (statuses.statuses.length > 0 && statuses.state !== "success")) {
          throw new ControlPlaneError("FORBIDDEN", "GitHub CI did not verify the software branch");
        }
        const payload = JSON.stringify({
          repository: plan.repository,
          branch: plan.isolatedBranch,
          headSha,
          checks: checks.check_runs
            .map((item) => ({ id: item.id, name: item.name, conclusion: item.conclusion }))
            .sort((a, b) => a.id - b.id),
          statuses: statuses.statuses
            .map((item) => ({ id: item.id ?? 0, context: item.context, state: item.state }))
            .sort((a, b) => a.context.localeCompare(b.context))
        });
        return Object.freeze({
          headSha,
          checkRunIds: Object.freeze(checks.check_runs.map((item) => item.id).sort((a, b) => a - b)),
          statusContextIds: Object.freeze(statuses.statuses.map((item) => item.context).sort()),
          evidenceHash: sha256(payload)
        });
      }

      if (Date.now() - started >= this.ciTimeoutMs) {
        throw new ControlPlaneError("UNAVAILABLE", "GitHub CI evidence did not become conclusive before timeout");
      }
      await this.sleep(this.ciPollIntervalMs);
    }
  }

  private async githubJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = process.env[this.tokenEnvVar];
    if (!token) {
      throw new ControlPlaneError("UNAVAILABLE", `${this.tokenEnvVar} is required for GitHub software-worker operations`);
    }
    const response = await this.fetchImpl(`https://api.github.com${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "getdone-software-worker",
        ...(init.headers ?? {})
      }
    });
    if (!response.ok) {
      throw new ControlPlaneError("UNAVAILABLE", "GitHub software-worker request failed", {
        details: { status: response.status, path }
      });
    }
    return await response.json() as T;
  }

  private async gitOk(args: readonly string[]) {
    const result = await this.git.run(args, this.config.worktree);
    if (result.exitCode !== 0) {
      throw new ControlPlaneError("UNAVAILABLE", "Git operation failed", {
        details: {
          args: args.join(" "),
          stderrHash: sha256(result.stderr)
        }
      });
    }
    return result.stdout;
  }
}
