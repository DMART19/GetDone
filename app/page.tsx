import { AppHeader } from "@/components/app-header";
import { AppShell } from "@/components/app-shell";
import { HomeDashboard } from "@/components/home-dashboard";
import { OperationalSolarSystem } from "@/components/operational-solar-system";
import { getOwnerReadRepository } from "@/lib/data/runtime-repository.server";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const repository = await getOwnerReadRepository();
  const [objectives, resources] = await Promise.all([
    repository.listObjectives(),
    repository.listResources()
  ]);

  return (
    <AppShell>
      <AppHeader />
      <OperationalSolarSystem objectives={[...objectives]} resources={[...resources]} />
      <HomeDashboard objectives={[...objectives]} showChat={false} />
    </AppShell>
  );
}
