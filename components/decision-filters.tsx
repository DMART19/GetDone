"use client";

import { useState } from "react";
import { DecisionCard } from "@/components/decision-card";
import type { Decision, DecisionPriority } from "@/lib/types";

type Filter = "all" | DecisionPriority;

export function DecisionFilters({ decisions }: { decisions: Decision[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const visible = filter === "all" ? decisions : decisions.filter((decision) => decision.priority === filter);
  const counts = {
    all: decisions.length,
    high: decisions.filter((decision) => decision.priority === "high").length,
    normal: decisions.filter((decision) => decision.priority === "normal").length,
    fyi: decisions.filter((decision) => decision.priority === "fyi").length
  };

  return (
    <>
      <div className="decision-filter-row" role="tablist" aria-label="Decision filters">
        {(["all", "high", "normal", "fyi"] as Filter[]).map((item) => (
          <button key={item} type="button" onClick={() => setFilter(item)} className={filter === item ? "selected" : ""} role="tab" aria-selected={filter === item}>
            {item === "all" ? "All" : item === "fyi" ? "FYI" : item.charAt(0).toUpperCase() + item.slice(1)} <span>{counts[item]}</span>
          </button>
        ))}
      </div>
      <div className="decision-list">
        {visible.length ? visible.map((decision) => <DecisionCard key={decision.id} decision={decision} />) : <div className="empty-state">Nothing waiting in this category.</div>}
      </div>
    </>
  );
}
