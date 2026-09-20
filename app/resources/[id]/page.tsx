import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { BackHeader } from "@/components/back-header";
import { DevelopmentBadge } from "@/components/dev-badge";
import { ResourceIcon } from "@/components/resource-icon";
import { ResourceTabs } from "@/components/resource-tabs";
import { HealthStatus } from "@/components/status";
import { developmentOwnerRepository } from "@/lib/data/repository";

export async function generateStaticParams() {
  const resources = await developmentOwnerRepository.listResources();
  return resources.map((resource) => ({ id: resource.id }));
}

export default async function ResourceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const resource = await developmentOwnerRepository.getResource(id);
  if (!resource) notFound();

  return (
    <AppShell navigation={false}>
      <BackHeader title="Resource Details" href="/resources" showMenu />
      <DevelopmentBadge />
      <section className="page-content resource-detail-page">
        <div className="resource-hero">
          <ResourceIcon icon={resource.icon} large />
          <div>
            <h1>{resource.name} <HealthStatus health={resource.health} /></h1>
            <p>{resource.role} · {resource.provider}</p>
          </div>
        </div>

        <button type="button" className="primary-action resource-actions">
          Actions <span>⌄</span>
        </button>

        <ResourceTabs resource={resource} />

        <button type="button" className="capabilities-button">
          <span className="cube">◇</span>
          View Capabilities
          <ChevronRight size={17} />
        </button>

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
