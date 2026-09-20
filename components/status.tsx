import type { DecisionPriority, ResourceHealth } from "@/lib/types";

export function HealthStatus({ health }: { health: ResourceHealth }) {
  return (
    <span className={`health health-${health}`}>
      <span className="status-dot" />
      {health === "online" ? "Online" : health.charAt(0).toUpperCase() + health.slice(1)}
    </span>
  );
}

export function PriorityPill({ priority }: { priority: DecisionPriority }) {
  return <span className={`priority priority-${priority}`}>{priority === "fyi" ? "FYI" : priority.charAt(0).toUpperCase() + priority.slice(1)}</span>;
}
