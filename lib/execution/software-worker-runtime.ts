import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  createInitialSoftwarePipelineRecord,
  createSoftwareChangeEvidence,
  transitionSoftwarePipeline,
  type ProductionPromotionReceipt,
  type SoftwareChangeEvidence,
  type SoftwareDeploymentExecutor,
  type SoftwarePipelineRecord,
  type SoftwarePostDeploymentVerificationEvidence,
  type SoftwareWorkerPlan
} from "@/lib/execution/software-worker";

export const SOFTWARE_WORKER_RUNTIME_VERSION = "1.0.0";

export interface SoftwareWorkerTooling {
  inspect(plan: SoftwareWorkerPlan): Promise<void>;
  createBranch(plan: SoftwareWorkerPlan): Promise<void>;
  modify(plan: SoftwareWorkerPlan): Promise<{ commitSha: string; diffHash: string }>;
  staticAnalysis(plan: SoftwareWorkerPlan): Promise<readonly string[]>;
  test(plan: SoftwareWorkerPlan): Promise<readonly string[]>;
  securityCheck(plan: SoftwareWorkerPlan): Promise<readonly string[]>;
  preview(plan: SoftwareWorkerPlan): Promise<string>;
  stage(plan: SoftwareWorkerPlan): Promise<string>;
  verifyStaging(plan: SoftwareWorkerPlan, stagingDeploymentId: string): Promise<string>;
  rollback?(plan: SoftwareWorkerPlan, deploymentReference: string): Promise<void>;
}

export interface SoftwareRuntimeArtifacts {
  commitSha?: string;
  diffHash?: string;
  staticAnalysisEvidenceIds: readonly string[];
  testEvidenceIds: readonly string[];
  securityEvidenceIds: readonly string[];
  previewReference?: string;
  stagingDeploymentId?: string;
  stagingVerificationReceiptId?: string;
  changeEvidence?: SoftwareChangeEvidence;
}

export interface SoftwareWorkerRuntimeRecord {
  planId: string;
  planHash: string;
  pipeline: SoftwarePipelineRecord;
  artifacts: SoftwareRuntimeArtifacts;
  updatedAt: string;
  runtimeHash: string;
}

export interface SoftwareWorkerRuntimeStore {
  get(planId: string): Promise<SoftwareWorkerRuntimeRecord | null>;
  save(record: SoftwareWorkerRuntimeRecord, expectedRuntimeHash?: string): Promise<void>;
}

function createRuntimeRecord(input: Omit<SoftwareWorkerRuntimeRecord, "runtimeHash">) {
  return Object.freeze({ ...input, runtimeHash: sha256Hex(input) });
}

function emptyArtifacts(): SoftwareRuntimeArtifacts {
  return {
    staticAnalysisEvidenceIds: [],
    testEvidenceIds: [],
    securityEvidenceIds: []
  };
}

export class SoftwareWorkerRuntime {
  constructor(
    private readonly tooling: SoftwareWorkerTooling,
    private readonly deployments: SoftwareDeploymentExecutor,
    private readonly store: SoftwareWorkerRuntimeStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  async prepare(plan: SoftwareWorkerPlan): Promise<SoftwareWorkerRuntimeRecord> {
    let runtime = await this.store.get(plan.id);
    if (!runtime) {
      const initial = createInitialSoftwarePipelineRecord(plan);
      runtime = createRuntimeRecord({
        planId: plan.id,
        planHash: plan.planHash,
        pipeline: initial,
        artifacts: emptyArtifacts(),
        updatedAt: initial.updatedAt
      });
      await this.store.save(runtime);
    }
    this.assertPlan(runtime, plan);

    while (runtime.pipeline.state !== "awaiting-production-approval") {
      const previous = runtime;
      const at = this.now().toISOString();

      switch (runtime.pipeline.state) {
        case "inspect":
          await this.tooling.inspect(plan);
          await this.tooling.createBranch(plan);
          runtime = this.transitionRuntime(runtime, plan, "branch-created", at);
          break;
        case "branch-created": {
          const modified = await this.tooling.modify(plan);
          runtime = this.transitionRuntime(runtime, plan, "modified", at, {
            ...runtime.artifacts,
            commitSha: modified.commitSha,
            diffHash: modified.diffHash
          });
          break;
        }
        case "modified": {
          const ids = await this.tooling.staticAnalysis(plan);
          if (ids.length === 0) throw new ControlPlaneError("FORBIDDEN", "Static analysis produced no evidence");
          runtime = this.transitionRuntime(runtime, plan, "static-analysis", at, {
            ...runtime.artifacts,
            staticAnalysisEvidenceIds: [...ids]
          });
          break;
        }
        case "static-analysis": {
          const ids = await this.tooling.test(plan);
          if (ids.length === 0) throw new ControlPlaneError("FORBIDDEN", "Software tests produced no evidence");
          runtime = this.transitionRuntime(runtime, plan, "tested", at, {
            ...runtime.artifacts,
            testEvidenceIds: [...ids]
          });
          break;
        }
        case "tested": {
          const ids = await this.tooling.securityCheck(plan);
          if (ids.length === 0) throw new ControlPlaneError("FORBIDDEN", "Security checks produced no evidence");
          runtime = this.transitionRuntime(runtime, plan, "security-checked", at, {
            ...runtime.artifacts,
            securityEvidenceIds: [...ids]
          });
          break;
        }
        case "security-checked": {
          const previewReference = await this.tooling.preview(plan);
          runtime = this.transitionRuntime(runtime, plan, "preview", at, {
            ...runtime.artifacts,
            previewReference
          });
          break;
        }
        case "preview": {
          const stagingDeploymentId = await this.tooling.stage(plan);
          runtime = this.transitionRuntime(runtime, plan, "staging", at, {
            ...runtime.artifacts,
            stagingDeploymentId
          });
          break;
        }
        case "staging": {
          const stagingDeploymentId = runtime.artifacts.stagingDeploymentId;
          if (!stagingDeploymentId) {
            throw new ControlPlaneError("FORBIDDEN", "Staging deployment lineage is missing");
          }
          const stagingVerificationReceiptId =
            await this.tooling.verifyStaging(plan, stagingDeploymentId);
          const artifacts = {
            ...runtime.artifacts,
            stagingVerificationReceiptId
          };
          const evidence = this.changeEvidence(plan, artifacts);
          runtime = this.transitionRuntime(
            runtime,
            plan,
            "staging-verified",
            at,
            { ...artifacts, changeEvidence: evidence },
            { evidence }
          );
          break;
        }
        case "staging-verified":
          runtime = this.transitionRuntime(runtime, plan, "awaiting-production-approval", at);
          break;
        default:
          throw new ControlPlaneError(
            "CONFLICT",
            `Software preparation cannot resume from ${runtime.pipeline.state}`
          );
      }

      await this.store.save(runtime, previous.runtimeHash);
    }

    return runtime;
  }

  async authorizeProduction(
    plan: SoftwareWorkerPlan,
    promotion: ProductionPromotionReceipt
  ) {
    const current = await this.requireRuntime(plan.id);
    this.assertPlan(current, plan);
    if (current.pipeline.state !== "awaiting-production-approval") {
      throw new ControlPlaneError("CONFLICT", "Software pipeline is not awaiting production approval");
    }
    const next = this.transitionRuntime(
      current,
      plan,
      "production-authorized",
      this.now().toISOString(),
      undefined,
      { promotion }
    );
    await this.store.save(next, current.runtimeHash);
    return next;
  }

  async deployProduction(
    plan: SoftwareWorkerPlan,
    promotion: ProductionPromotionReceipt
  ) {
    let current = await this.requireRuntime(plan.id);
    this.assertPlan(current, plan);
    if (current.pipeline.state !== "production-authorized") {
      throw new ControlPlaneError("CONFLICT", "Software pipeline is not production-authorized");
    }
    const evidence = current.artifacts.changeEvidence;
    if (!evidence) throw new ControlPlaneError("FORBIDDEN", "Staged software change evidence is missing");

    const deployment = await this.deployments.deploy({ plan, evidence, promotion });
    let next = this.transitionRuntime(
      current,
      plan,
      "production-deployed",
      this.now().toISOString(),
      undefined,
      { deploymentEvidence: deployment }
    );
    await this.store.save(next, current.runtimeHash);

    current = next;
    next = this.transitionRuntime(
      current,
      plan,
      "post-deploy-verifying",
      this.now().toISOString()
    );
    await this.store.save(next, current.runtimeHash);
    return { runtime: next, deployment };
  }

  async completeProductionVerification(
    plan: SoftwareWorkerPlan,
    verification: SoftwarePostDeploymentVerificationEvidence
  ) {
    const current = await this.requireRuntime(plan.id);
    this.assertPlan(current, plan);
    if (current.pipeline.state !== "post-deploy-verifying") {
      throw new ControlPlaneError("CONFLICT", "Software pipeline is not awaiting post-deploy verification");
    }
    const next = this.transitionRuntime(
      current,
      plan,
      "succeeded",
      this.now().toISOString(),
      undefined,
      { postDeploymentVerification: verification }
    );
    await this.store.save(next, current.runtimeHash);
    return next;
  }

  async rollback(plan: SoftwareWorkerPlan) {
    const current = await this.requireRuntime(plan.id);
    this.assertPlan(current, plan);
    if (!["production-deployed", "post-deploy-verifying"].includes(current.pipeline.state)) {
      throw new ControlPlaneError("CONFLICT", "Rollback is only valid after production deployment");
    }
    if (!current.pipeline.deploymentReference || !this.tooling.rollback) {
      throw new ControlPlaneError("UNAVAILABLE", "Rollback tooling/reference is unavailable");
    }
    await this.tooling.rollback(plan, current.pipeline.deploymentReference);
    const next = this.transitionRuntime(
      current,
      plan,
      "rolled-back",
      this.now().toISOString()
    );
    await this.store.save(next, current.runtimeHash);
    return next;
  }

  private async requireRuntime(planId: string) {
    const runtime = await this.store.get(planId);
    if (!runtime) throw new ControlPlaneError("NOT_FOUND", "Software worker runtime was not found");
    return runtime;
  }

  private assertPlan(runtime: SoftwareWorkerRuntimeRecord, plan: SoftwareWorkerPlan) {
    if (runtime.planId !== plan.id || runtime.planHash !== plan.planHash) {
      throw new ControlPlaneError("FORBIDDEN", "Software worker runtime belongs to a different plan");
    }
  }

  private changeEvidence(
    plan: SoftwareWorkerPlan,
    artifacts: SoftwareRuntimeArtifacts
  ) {
    if (!artifacts.commitSha || !artifacts.diffHash) {
      throw new ControlPlaneError("FORBIDDEN", "Software modification evidence is incomplete");
    }
    return createSoftwareChangeEvidence({
      planId: plan.id,
      planHash: plan.planHash,
      repository: plan.repository,
      isolatedBranch: plan.isolatedBranch,
      commitSha: artifacts.commitSha,
      diffHash: artifacts.diffHash,
      staticAnalysisEvidenceIds: artifacts.staticAnalysisEvidenceIds,
      testEvidenceIds: artifacts.testEvidenceIds,
      securityEvidenceIds: artifacts.securityEvidenceIds,
      previewReference: artifacts.previewReference,
      stagingDeploymentId: artifacts.stagingDeploymentId,
      stagingVerificationReceiptId: artifacts.stagingVerificationReceiptId
    });
  }

  private transitionRuntime(
    runtime: SoftwareWorkerRuntimeRecord,
    plan: SoftwareWorkerPlan,
    to: Parameters<typeof transitionSoftwarePipeline>[0]["to"],
    updatedAt: string,
    artifacts: SoftwareRuntimeArtifacts = runtime.artifacts,
    extras: Omit<
      Parameters<typeof transitionSoftwarePipeline>[0],
      "current" | "to" | "updatedAt" | "plan"
    > = {}
  ) {
    const pipeline = transitionSoftwarePipeline({
      current: runtime.pipeline,
      to,
      updatedAt,
      plan,
      ...extras
    });
    const base = {
      planId: runtime.planId,
      planHash: runtime.planHash,
      pipeline,
      artifacts,
      updatedAt
    };
    return createRuntimeRecord(base);
  }
}
