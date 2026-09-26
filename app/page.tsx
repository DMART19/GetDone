import { AppHeader } from "@/components/app-header";
import { AppShell } from "@/components/app-shell";
import { HomeDashboard } from "@/components/home-dashboard";
import { getOwnerReadRepository } from "@/lib/data/runtime-repository.server";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const repository = await getOwnerReadRepository();
  const [decisions, resources] = await Promise.all([
    repository.listDecisions(),
    repository.listResources()
  ]);
  const pending = decisions.filter((decision) => decision.status === "pending");
  const attentionCount = pending.filter((decision) => decision.priority === "high").length;
  const healthy = resources.every(
    (resource) => resource.health !== "degraded" && resource.health !== "offline"
  );

  return (
    <AppShell>
      <AppHeader />
      <HomeDashboard
        attentionCount={attentionCount}
        resourceCount={resources.length}
        healthy={healthy}
      />
    </AppShell>
  );
}
