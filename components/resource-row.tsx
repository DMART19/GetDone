import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { HealthStatus } from "@/components/status";
import { ResourceIcon } from "@/components/resource-icon";
import type { Resource } from "@/lib/types";

export function ResourceRow({ resource }: { resource: Resource }) {
  return (
    <Link href={`/resources/${resource.id}`} className="resource-row">
      <ResourceIcon icon={resource.icon} />
      <span className="resource-copy">
        <strong>{resource.name}</strong>
        <small>{resource.role}</small>
      </span>
      <HealthStatus health={resource.health} />
      <ChevronRight size={18} className="row-chevron" />
    </Link>
  );
}
