import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { BackHeader } from "@/components/back-header";
import { DevelopmentBadge } from "@/components/dev-badge";
import { ResourceIcon } from "@/components/resource-icon";
import { ResourceTabs } from "@/components/resource-tabs";
import { HealthStatus } from "@/components/status";
import { getOwnerReadRepository } from "@/lib/data/runtime-repository.server";

export const dynamic = "force-dynamic";

export default async function ResourceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const repository = await getOwnerReadRepository();
  const resource = await repository.getResource(id);
  if (!resource) notFound();

  return (
    <AppShell navigation={false}>
      <BackHeader title="Resource Details" href="/resources" />
      <DevelopmentBadge />
      <section className="page-content resource-detail-page">
        <div className="resource-hero">
          <ResourceIcon icon={resource.icon} large />
          <div>
            <h1>{resource.name} <HealthStatus health={resource.health} /></h1>
            <p>{resource.role} · {resource.provider}</p>
          </div>
        </div>

        <button type="button" className="primary-action resource-actions" disabled title="No governed actions are currently available">
          No actions available
        </button>

        <ResourceTabs resource={resource} />

        <a href="#resource-capabilities" className="capabilities-button">
          <span className="cube">◇</span>
          View Capabilities
          <ChevronRight size={17} />
        </a>

        <section id="resource-capabilities" className="workload-card" aria-labelledby="resource-capabilities-heading">
          <div>
            <strong id="resource-capabilities-heading">Governed capabilities</strong>
            <span>
              {resource.capabilityNames?.length
                ? resource.capabilityNames.join(" · ")
                : "No governed capabilities are registered for this resource."}
            </span>
          </div>
        </section>

        <section className="workload-card">
          <div>
            <strong>Current Workloads</strong>
            <span>{resource.workloads.running} running · {resource.workloads.queued} queued</span>
          </div>
          <div className="progress">
            <i style={{ width: `${resource.workloads.utilization}%` }} />
          </div>
        </section>
      </section>
    </AppShell>
  );
}
