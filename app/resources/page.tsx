import { AppHeader } from "@/components/app-header";
import { AppShell } from "@/components/app-shell";
import { ResourceOverview } from "@/components/resource-overview";
import { DavidResourceDesk } from "@/components/david-resource-desk";
import { getOwnerReadRepository } from "@/lib/data/runtime-repository.server";

export const dynamic = "force-dynamic";

export default async function ResourcesPage() {
  const repository = await getOwnerReadRepository();
  const [resourceSummary, resources] = await Promise.all([
    repository.getResourceSummary(), repository.listResources()
  ]);
  const records = [...resources];
  return <AppShell>{process.env.GETDONE_DAVID_EDITION === "true"
    ? <DavidResourceDesk summary={resourceSummary} resources={records} />
    : <><AppHeader/><section className="ufo-page ufo-resources-page">
        <div className="ufo-page-title"><h1>Resources</h1><p>All your compute, storage, people and infrastructure. It just works.</p></div>
        <ResourceOverview summary={resourceSummary} resources={records}/>
      </section></>}
  </AppShell>;
}
