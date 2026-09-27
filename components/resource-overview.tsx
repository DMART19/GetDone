import Link from "next/link";
import {
  ChevronRight,
  Cloud,
  Cpu,
  Database,
  DollarSign,
  HardDrive,
  Network,
  Plus,
  Users
} from "lucide-react";
import type { OwnerResourceSummary } from "@/lib/data/repository";
import type { Resource } from "@/lib/types";

type ResourceGroup = {
  label: string;
  icon: typeof Cloud;
  kinds: Resource["kind"][];
};

const groups: ResourceGroup[] = [
  { label: "Cloud Providers", icon: Cloud, kinds: ["cloud", "partner"] },
  { label: "Data & Storage", icon: Database, kinds: ["storage"] },
  { label: "Integrations", icon: Network, kinds: ["network", "other"] },
  { label: "Team & Agents", icon: Users, kinds: ["compute"] }
];

function averageUtilization(resources: Resource[]) {
  if (!resources.length) return null;
  const values = resources
    .map((resource) => resource.workloads.utilization)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function healthFor(resources: Resource[]) {
  if (!resources.length) return { label: "Ready to connect", tone: "empty" };
  if (resources.some((resource) => resource.health === "offline")) {
    return { label: "Attention", tone: "bad" };
  }
  if (resources.some((resource) => resource.health === "degraded")) {
    return { label: "Degraded", tone: "warning" };
  }
  return { label: "Healthy", tone: "good" };
}

export function ResourceOverview({
  summary,
  resources
}: {
  summary: OwnerResourceSummary;
  resources: Resource[];
}) {
  const compute = resources.filter((resource) => resource.kind === "compute");
  const storage = resources.filter((resource) => resource.kind === "storage");
  const computeUtilization = averageUtilization(compute);
  const storageUtilization = averageUtilization(storage);
  const overall = healthFor(resources);
  const activeAgents = summary.activeAgents;

  return (
    <div className="ufo-resource-overview">
      <div className={"ufo-health-banner ufo-health-" + overall.tone}>
        <span className="ufo-health-orb"><i /></span>
        <span>
          <strong>{overall.label === "Healthy" ? "Everything Healthy" : summary.health}</strong>
          <small>{resources.length ? "All systems operating within their current governed scope." : "Connect a resource to begin."}</small>
        </span>
        <ChevronRight size={20} />
      </div>

      <div className="ufo-resource-metrics">
        <article>
          <Cpu size={20} />
          <span>Compute</span>
          <strong>{computeUtilization === null ? "—" : computeUtilization + "%"}</strong>
          <small>{compute.length ? "Available" : "Not connected"}</small>
        </article>
        <article>
          <HardDrive size={20} />
          <span>Storage</span>
          <strong>{storageUtilization === null ? "—" : storageUtilization + "%"}</strong>
          <small>{storage.length ? "Available" : "Not connected"}</small>
        </article>
        <article>
          <DollarSign size={20} />
          <span>Spend</span>
          <strong>{summary.monthlySpend}</strong>
          <small>{summary.monthlyChange}</small>
        </article>
        <article>
          <Users size={20} />
          <span>Agents</span>
          <strong>{activeAgents === undefined ? "—" : activeAgents}</strong>
          <small>{activeAgents === undefined ? "Not connected" : "Active"}</small>
        </article>
      </div>

      <div className="ufo-resource-groups">
        {groups.map(({ label, icon: Icon, kinds }) => {
          const members = resources.filter((resource) => kinds.includes(resource.kind));
          const health = healthFor(members);
          const subtitle = members.length
            ? members.slice(0, 3).map((resource) => resource.name).join(", ")
            : "No resources connected yet";
          const href = members[0] ? "/resources/" + encodeURIComponent(members[0].id) : "/resources/add";

          return (
            <Link href={href} key={label} className="ufo-resource-group">
              <span className="ufo-group-icon"><Icon size={20} /></span>
              <span>
                <strong>{label}</strong>
                <small>{subtitle}</small>
              </span>
              <span className={"ufo-group-health ufo-group-health-" + health.tone}>
                <i /> {health.label}
              </span>
              <ChevronRight size={18} />
            </Link>
          );
        })}
      </div>

      <Link href="/resources/add" className="ufo-add-resource">
        <span><Plus size={24} /></span>
        <span>
          <strong>Add Resource</strong>
          <small>GetDone will set it up through the governed enrollment flow.</small>
        </span>
      </Link>
    </div>
  );
}
