import Link from "next/link";
import { Plus, ShieldAlert } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { AppShell } from "@/components/app-shell";
import { DevelopmentBadge } from "@/components/dev-badge";
import { ResourceFilters } from "@/components/resource-filters";
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
      <AppHeader />
      <DevelopmentBadge />
      <section className="page-content">
        <div className="title-row">
          <div>
            <h1>Resources <span className="new-label">NEW</span></h1>
            <p>All your compute, storage and infrastructure in one place.</p>
          </div>
        </div>
        <div className="summary-grid">
          <article className="summary-card"><span>Health</span><strong className="health-hero"><i />{resourceSummary.health}</strong><small>{resourceSummary.resourceCount} resources</small></article>
          <article className="summary-card"><span>Total Capacity</span><strong>{resourceSummary.capacity}% used</strong><div className="progress"><i style={{ width: `${resourceSummary.capacity}%` }} /></div></article>
          <article className="summary-card"><span>Monthly Spend</span><strong>{resourceSummary.monthlySpend}</strong><small className="good-text">{resourceSummary.monthlyChange}</small></article>
          <article className="summary-card"><span>Savings (Owned)</span><strong>{resourceSummary.ownedSavings}</strong><small>vs. variable cloud</small></article>
        </div>
        <ResourceFilters resources={[...resources]} />
        <Link href="/resources/add" className="add-resource-button"><Plus size={19} /> Add Resource</Link>
      </section>
    </AppShell>
  );
}
