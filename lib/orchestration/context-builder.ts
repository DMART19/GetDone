import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  assembleContext,
  type ContextAssemblyOptions,
  type ContextItem,
  type ContextScope
} from "@/lib/intelligence/context";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import {
  createContextSnapshot,
  planningArtifactId,
  type OrchestrationContextSnapshot
} from "@/lib/orchestration/planning-artifacts";

export interface OrchestrationContextSourceResult {
  items: readonly ContextItem[];
  scope: ContextScope;
  options?: ContextAssemblyOptions;
}

export type ContextSourceLoadResult =
  | Readonly<{ kind: "ready"; context: OrchestrationContextSourceResult }>
  | Readonly<{ kind: "unavailable"; reason: string; retryAt: string }>;

export interface OrchestrationContextSource {
  load(run: OrchestrationRun): Promise<ContextSourceLoadResult>;
}

const sensitivityRank = {
  public: 0,
  internal: 1,
  customer: 2,
  sensitive: 3
} as const;

function requiredDataClass(items: readonly ContextItem[]) {
  let selected: ContextItem["sensitivity"] = "internal";
  for (const item of items) {
    if (sensitivityRank[item.sensitivity] > sensitivityRank[selected]) {
      selected = item.sensitivity;
    }
  }
  return selected;
}

export class OrchestrationContextBuilder {
  constructor(
    private readonly source: OrchestrationContextSource,
    private readonly now: () => Date = () => new Date()
  ) {}

  async build(run: OrchestrationRun): Promise<
    | Readonly<{ kind: "ready"; snapshot: OrchestrationContextSnapshot }>
    | Readonly<{ kind: "unavailable"; reason: string; retryAt: string }>
  > {
    const loaded = await this.source.load(run);
    if (loaded.kind === "unavailable") return loaded;

    if (
      loaded.context.scope.portfolioId !== run.portfolioId
      || loaded.context.scope.companyId !== run.companyId
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Context source returned a scope outside the orchestration authority"
      );
    }

    const createdAt = this.now().toISOString();
    const assembled = assembleContext(
      loaded.context.items,
      loaded.context.scope,
      {
        ...loaded.context.options,
        now: this.now().getTime()
      }
    );

    if (assembled.items.length === 0) {
      return Object.freeze({
        kind: "unavailable" as const,
        reason: "no-authorized-fresh-context",
        retryAt: new Date(this.now().getTime() + 30_000).toISOString()
      });
    }

    const predecessorHash = run.correlationId;
    const snapshot = createContextSnapshot({
      id: planningArtifactId({
        kind: "context-snapshot",
        runId: run.id,
        predecessorHash
      }),
      runId: run.id,
      correlationId: run.correlationId,
      portfolioId: run.portfolioId,
      companyId: run.companyId,
      environment: run.environment,
      dataClass: requiredDataClass(assembled.items),
      assembled,
      createdAt
    });

    return Object.freeze({ kind: "ready" as const, snapshot });
  }
}
