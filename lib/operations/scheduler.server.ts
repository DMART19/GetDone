import { z } from "zod";
import { listBusinesses } from "@/lib/businesses/repository";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";
import type { ObjectiveRecord } from "@/lib/domain/objective-inbox";
import { OperationalStore } from "./store.server";
import { runGuardedObjectiveReentry } from "@/lib/orchestration/guarded-continuation.server";

const metricSchema = z.object({ objectiveId: z.string().min(1), topic: z.string().min(1), key: z.string().min(1),
  target: z.number().finite(), operator: z.enum(["gte", "lte"]) }).passthrough();
/** Each tick rechecks active membership. Only local evaluation/inbox records are writable. */
export async function runObjectiveEvaluationPass(db: PostgresTransactionalDatabase, userId: string,
  environment: "development" | "staging" | "production", now: string,
  continuationEnabled = process.env.GETDONE_GOVERNED_REENTRY_ENABLED === "true") {
  let evaluated = 0;
  let reentered = 0;
  for (const business of await listBusinesses(db, userId)) {
    const owner = await db.query(`SELECT 1 FROM portfolio_memberships
      WHERE user_id=$1 AND portfolio_id=$2 AND company_id=$3 AND role='owner' AND status='active'`,
      [userId, business.portfolioId, business.id]);
    if (!owner.rowCount) continue;
    await runWithPostgresTenantScope({ portfolioId: business.portfolioId, companyId: business.id }, async () => {
      const store = new OperationalStore(db, { userId, portfolioId: business.portfolioId, companyId: business.id, environment });
      const objectives = await store.list<ObjectiveRecord>("objective");
      const metrics = await store.list<unknown>("objective-metric");
      await store.captureVerifiedOutcomes(now);
      const reentry = await runGuardedObjectiveReentry(db,
        { userId, portfolioId: business.portfolioId, companyId: business.id, environment }, now, continuationEnabled);
      reentered += reentry.created;
      await store.refreshInbox(now);
      for (const raw of metrics) {
        const metric = metricSchema.safeParse(raw);
        if (!metric.success) continue;
        const objective = objectives.find(o => o.id === metric.data.objectiveId);
        if (!objective || ["completed", "cancelled"].includes(objective.status)) continue;
        await store.evaluateScheduled(objective, metric.data, now); evaluated++;
      }
    });
  }
  return { evaluated, reentered, consequentialActionsExecuted: 0 as const };
}
