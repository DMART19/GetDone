"use client";

import { useState } from "react";
import type { Resource } from "@/lib/types";

const tabs = ["Overview", "Usage", "Cost", "Health"] as const;
type Tab = (typeof tabs)[number];

export function ResourceTabs({ resource }: { resource: Resource }) {
  const [tab, setTab] = useState<Tab>("Overview");

  return (
    <>
      <div className="detail-tabs" role="tablist">
        {tabs.map((item) => <button key={item} type="button" onClick={() => setTab(item)} className={tab === item ? "selected" : ""} role="tab" aria-selected={tab === item}>{item}</button>)}
      </div>
      {tab === "Overview" ? (
        <div className="info-list">
          <div><span>Location</span><strong>{resource.location}</strong></div>
          <div><span>Provider</span><strong>{resource.provider}</strong></div>
          <div><span>Environments</span><strong>{resource.environments.join(" · ")}</strong></div>
          <div><span>Customer Data</span><strong>{resource.customerDataPolicy}</strong></div>
          <div><span>Reliability Tier</span><strong>{resource.reliabilityTier}</strong></div>
          <div><span>Auto-scheduling</span><strong className={resource.autoScheduling ? "good-text" : ""}>{resource.autoScheduling ? "Enabled" : "Disabled"}</strong></div>
        </div>
      ) : null}
      {tab === "Usage" ? <div className="tab-panel"><strong>{resource.workloads.utilization}% utilization</strong><p>Development preview only. Deep telemetry is intentionally deferred.</p></div> : null}
      {tab === "Cost" ? <div className="tab-panel"><strong>{resource.metrics.at(-1)?.value ?? "Not available"}</strong><p>Seeded effective-cost preview. No billing system is connected.</p></div> : null}
      {tab === "Health" ? <div className="tab-panel"><strong>{resource.health.toUpperCase()}</strong><p>Health is development seed data, not live resource telemetry.</p></div> : null}
    </>
  );
}
