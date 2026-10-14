import { AppHeader } from "@/components/app-header";
import { AppShell } from "@/components/app-shell";
import { DavidResourceDesk } from "@/components/david-resource-desk";
import { getOwnerReadRepository } from "@/lib/data/runtime-repository.server";

export const dynamic = "force-dynamic";

export default async function ResourcesPage() {
  const repository = await getOwnerReadRepository();
  const [resourceSummary, resources] = await Promise.all([
    repository.getResourceSummary(),
    repository.listResources()
  ]);

  return (
    <AppShell>
      <DavidResourceDesk summary={resourceSummary} resources={[...resources]} />
    </AppShell>
  );
}
