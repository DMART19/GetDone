import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { OwnerIntentRecord } from "@/lib/control-api/contracts";
import type { ContextItem } from "@/lib/intelligence/context";
import type {
  ContextSourceLoadResult,
  OrchestrationContextSource
} from "@/lib/orchestration/context-builder";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";

export interface PostgresOwnerIntentContextSourceConfig {
  sensitivity: ContextItem["sensitivity"];
  freshnessSeconds?: number;
  maxCharacters?: number;
}

export class PostgresOwnerIntentContextSource implements OrchestrationContextSource {
  constructor(
    private readonly db: PostgresTransactionalDatabase,
    private readonly config: PostgresOwnerIntentContextSourceConfig
  ) {}

  async load(run: OrchestrationRun): Promise<ContextSourceLoadResult> {
    if (run.source.kind !== "owner-intent") {
      return Object.freeze({
        kind: "unavailable" as const,
        reason: `context-source-not-connected:${run.source.kind}`,
        retryAt: new Date(Date.now() + 60_000).toISOString()
      });
    }

    const intent = await runWithPostgresTenantScope(
      { portfolioId: run.portfolioId, companyId: run.companyId },
      () => this.db.transaction(async (client) => {
        const result = await client.query<{ payload: OwnerIntentRecord }>(
          `SELECT payload FROM owner_intents
           WHERE id=$1 AND portfolio_id=$2 AND company_id=$3`,
          [run.source.ownerIntentId, run.portfolioId, run.companyId]
        );
        return result.rows[0]?.payload ?? null;
      })
    );

    if (!intent) {
      throw new ControlPlaneError(
        "NOT_FOUND",
        "Orchestration source OwnerIntent was not found in authoritative storage"
      );
    }
    if (
      intent.userId !== run.authorityUserId
      || intent.environment !== run.environment
      || intent.correlationId !== run.correlationId
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "OwnerIntent authority envelope does not match the orchestration run"
      );
    }

    const item: ContextItem = Object.freeze({
      id: `owner-input:${intent.id}`,
      kind: "fact",
      portfolioId: run.portfolioId,
      companyId: run.companyId,
      source: "owner-intent",
      provenance: `owner-intent:${intent.id}`,
      observedAt: intent.receivedAt,
      freshnessSeconds: this.config.freshnessSeconds ?? 31_536_000,
      sensitivity: this.config.sensitivity,
      content: intent.message
    });

    return Object.freeze({
      kind: "ready" as const,
      context: Object.freeze({
        items: Object.freeze([item]),
        scope: Object.freeze({
          portfolioId: run.portfolioId,
          companyId: run.companyId,
          allowedSensitivity: Object.freeze([this.config.sensitivity])
        }),
        options: Object.freeze({
          maxItems: 30,
          maxCharacters: this.config.maxCharacters ?? 24_000
        })
      })
    });
  }
}
