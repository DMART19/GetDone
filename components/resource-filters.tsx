"use client";

import { useMemo, useState } from "react";
import { ResourceRow } from "@/components/resource-row";
import type { Resource } from "@/lib/types";

const filters = ["all", "compute", "storage", "network"] as const;
type Filter = (typeof filters)[number];

export function ResourceFilters({ resources }: { resources: Resource[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const visible = useMemo(() => filter === "all" ? resources : resources.filter((resource) => resource.kind === filter), [filter, resources]);

  return (
    <>
      <div className="segmented" role="tablist" aria-label="Resource filters">
        {filters.map((item) => (
          <button key={item} type="button" className={filter === item ? "selected" : ""} onClick={() => setFilter(item)} role="tab" aria-selected={filter === item}>
            {item.charAt(0).toUpperCase() + item.slice(1)}
          </button>
        ))}
      </div>
      <div className="resource-list">
        {visible.length ? visible.map((resource) => <ResourceRow key={resource.id} resource={resource} />) : <div className="empty-state">No {filter} resources are available.</div>}
      </div>
    </>
  );
}
