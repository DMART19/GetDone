"use client";

import { useMemo, useState } from "react";
import type { ObjectiveView, Resource } from "@/lib/types";

type Health = "green" | "yellow" | "red" | "unknown";
type Node = { id: string; name: string; kind: string; health: Health; explanation: string; href?: string };
const palette: Record<Health, string> = {
  green: "#4be38b", yellow: "#ffc72c", red: "#ff445c", unknown: "#8495a8"
};

function resourceHealth(resource: Resource): Health {
  if (resource.health === "healthy") return "green";
  if (resource.health === "degraded") return "yellow";
  if (resource.health === "offline") return "red";
  return "unknown";
}

export function OperationalSolarSystem({ resources, objectives }: {
  resources: Resource[]; objectives: ObjectiveView[];
}) {
  const [selected, setSelected] = useState<string>("getdone");
  const nodes = useMemo<Node[]>(() => resources.map((resource) => ({
    id: resource.id,
    name: resource.name,
    kind: resource.kind,
    health: resourceHealth(resource),
    explanation: resource.role + " · " + resource.provider,
    href: "/resources/" + encodeURIComponent(resource.id)
  })), [resources]);
  const failures = objectives.filter((objective) => objective.status === "failed" || objective.status === "blocked");
  const warnings = objectives.filter((objective) => objective.status === "needs_owner_input" || objective.status === "partially_completed");
  const rootHealth: Health = failures.length || nodes.some((node) => node.health === "red")
    ? "red" : warnings.length || nodes.some((node) => node.health === "yellow")
      ? "yellow" : "unknown";
  const current = nodes.find((node) => node.id === selected);
  return (
    <section aria-label="GetDone operational solar system" style={{ padding: "18px", margin: "12px 16px", border: "1px solid #23364b", borderRadius: 18, background: "#07111e" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <strong>Operational universe</strong>
        <span style={{ color: "#aab9ca", fontSize: 11 }}>Read-only · live repository data</span>
      </div>
      <p style={{ fontSize: 12, color: "#9eb2c9" }}>Select a node to inspect its recorded status. Unregistered products are never shown as connected.</p>
      <svg role="img" aria-label="GetDone connected to registered resources" viewBox="0 0 340 235" style={{ width: "100%", maxHeight: 320 }}>
        <circle cx="170" cy="115" r="82" stroke="#2b4b6b" strokeDasharray="4 6" fill="none" />
        <circle cx="170" cy="115" r="110" stroke="#1d334c" strokeDasharray="3 7" fill="none" />
        {nodes.slice(0, 12).map((node, index) => {
          const angle = index * Math.PI * 2 / Math.max(1, Math.min(nodes.length, 12)) - Math.PI / 2;
          const x = 170 + 107 * Math.cos(angle), y = 115 + 87 * Math.sin(angle);
          const active = selected === node.id;
          return <g key={node.id}>
            <line x1="170" y1="115" x2={x} y2={y} stroke={palette[node.health]} strokeWidth={active ? 3 : 1} opacity={active ? 1 : .35} />
            <circle cx={x} cy={y} r={active ? 17 : 13} fill="#13263a" stroke={palette[node.health]} strokeWidth={active ? 3 : 1.5} />
            <text x={x} y={y + 3} textAnchor="middle" fill="#fff" fontSize="8">{index + 1}</text>
          </g>;
        })}
        <circle cx="170" cy="115" r="36" fill="#174b79" stroke={palette[rootHealth]} strokeWidth={selected === "getdone" ? 4 : 2} />
        <text x="170" y="119" textAnchor="middle" fill="white" fontSize="12" fontWeight="bold">GetDone</text>
      </svg>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 12 }}>
        <button type="button" onClick={() => setSelected("getdone")} aria-pressed={selected === "getdone"} style={{ padding: "10px 12px", borderRadius: 12, background: selected === "getdone" ? "#1c4568" : "#102234", color: "#fff", border: "1px solid #35516b" }}>GetDone</button>
        {nodes.map((node, index) => <button key={node.id} type="button" onClick={() => setSelected(node.id)} aria-pressed={selected === node.id} style={{ padding: "10px 12px", borderRadius: 12, background: selected === node.id ? "#1c4568" : "#102234", color: "#fff", border: "1px solid " + palette[node.health] }}>
          {index + 1}. {node.name}
        </button>)}
      </div>
      <div aria-live="polite" style={{ padding: 12, background: "#0c1b2b", borderRadius: 12, fontSize: 12 }}>
        <strong style={{ color: palette[current?.health ?? rootHealth] }}>{current?.name ?? "GetDone"} · {current?.health ?? rootHealth}</strong>
        <p style={{ color: "#b8c8d9" }}>{current?.explanation ?? (failures.length + " failed/blocked objectives; " + warnings.length + " needing attention; " + resources.length + " registered resources.")}</p>
        {current?.href ? <a href={current.href} style={{ color: "#8bcaff" }}>Open resource details →</a> : null}
        {!resources.length ? <p style={{ color: "#c9a86a" }}>No registered resources available. Product connections and health cannot be verified from this view.</p> : null}
        {resources.length > 12 ? <p style={{ color: "#c9a86a" }}>Showing the first 12 resources in the diagram; all are selectable below.</p> : null}
      </div>
      <p style={{ fontSize: 11, color: "#8495a8", marginBottom: 0 }}>Green = ready · Yellow = degraded · Red = failed/offline · Gray = unverified. Resource health is not proof of overall product health.</p>
    </section>
  );
}
