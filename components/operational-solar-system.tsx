"use client";

import { useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import type { ObjectiveView, Resource } from "@/lib/types";
import "./operational-solar-system.css";

type Health = "healthy" | "warning" | "critical" | "unknown";
type Node = { id: string; name: string; kind: string; health: Health; detail: string; href: string };
const colors: Record<Health, string> = { healthy:"#4be38b",warning:"#ffc72c",critical:"#ff445c",unknown:"#8295ac" };
function healthOf(resource: Resource): Health {
  if (resource.health === "healthy") return "healthy";
  if (resource.health === "degraded") return "warning";
  if (resource.health === "offline") return "critical";
  return "unknown";
}
export function OperationalSolarSystem({ resources, objectives }: { resources: Resource[]; objectives: ObjectiveView[] }) {
  const [selected, setSelected] = useState("getdone");
  const nodes = useMemo<Node[]>(() => resources.map(resource => ({
    id:resource.id, name:resource.name, kind:resource.kind, health:healthOf(resource),
    detail:resource.role + " · " + resource.provider, href:"/resources/" + encodeURIComponent(resource.id)
  })), [resources]);
  const failures = objectives.filter(o => o.status === "failed" || o.status === "blocked").length;
  const warnings = objectives.filter(o => o.status === "needs_owner_input" || o.status === "partially_completed").length;
  const rootHealth: Health = failures || nodes.some(n=>n.health==="critical") ? "critical"
    : warnings || nodes.some(n=>n.health==="warning") ? "warning" : "unknown";
  const active = nodes.find(n=>n.id===selected);
  const activeHealth = active?.health ?? rootHealth;
  const visible = nodes.slice(0,18);
  return <section className="universe" aria-label="Read-only GetDone operational universe">
    <header className="universe-top">
      <div><span className="universe-eyebrow">GETDONE / LIVE OPERATIONS</span><h1>Operational universe</h1></div>
      <span className="universe-readonly">● READ ONLY</span>
    </header>
    <div className="universe-stage">
      <div className="universe-space" aria-label="Connected resources">
        <div className="universe-orbit universe-orbit-one" aria-hidden="true" />
        <div className="universe-orbit universe-orbit-two" aria-hidden="true" />
        <svg className="universe-lines" viewBox="0 0 1000 650" preserveAspectRatio="none" aria-hidden="true">
          {visible.map((node,i)=>{
            const a=2*Math.PI*i/Math.max(visible.length,1)-Math.PI/2;
            const x=500+365*Math.cos(a),y=325+235*Math.sin(a);
            return <line key={node.id} x1="500" y1="325" x2={x} y2={y} stroke={colors[node.health]} strokeWidth={selected===node.id?3:1} opacity={selected===node.id?0.95:selected==="getdone"?0.42:0.12}/>;
          })}
        </svg>
        <button type="button" className={"universe-sun"+(selected==="getdone"?" is-selected":"")} onClick={()=>setSelected("getdone")} aria-pressed={selected==="getdone"} style={{"--planet-health":colors[rootHealth]} as CSSProperties}>
          <span className="universe-sun-core">GetDone</span>
        </button>
        {visible.map((node,i)=>{
          const a=2*Math.PI*i/Math.max(visible.length,1)-Math.PI/2;
          return <button key={node.id} type="button" aria-label={node.name+" "+node.health} aria-pressed={selected===node.id}
            onClick={()=>setSelected(node.id)} className={"universe-planet"+(selected===node.id?" is-selected":"")}
            style={{left:(50+36.5*Math.cos(a))+"%",top:(50+36.15*Math.sin(a))+"%","--planet-health":colors[node.health]} as CSSProperties}>
            <span className="universe-planet-core" /><span className="universe-planet-label">{node.name}</span>
          </button>;
        })}
        {!nodes.length && <div className="universe-empty">No registered resources yet. Product connections are unverified.</div>}
      </div>
      <aside className="universe-inspector" aria-live="polite">
        <span className="universe-eyebrow">SELECTED NODE</span>
        <h2>{active?.name ?? "GetDone"}</h2>
        <span className="universe-health" style={{color:colors[activeHealth]}}>● {activeHealth==="healthy"?"Healthy":activeHealth==="warning"?"Needs attention":activeHealth==="critical"?"Critical":"Unverified"}</span>
        <p>{active?.detail ?? "GetDone control plane · recorded resources and objectives"}</p>
        <div className="universe-metrics">
          {active ? <><span>Resource type</span><strong>{active.kind}</strong></> : <>
            <span>Registered resources</span><strong>{resources.length}</strong>
            <span>Failed / blocked objectives</span><strong>{failures}</strong>
            <span>Owner attention</span><strong>{warnings}</strong>
          </>}
        </div>
        {active && <Link className="universe-details" href={active.href}>View resource details ↗</Link>}
        <span className="universe-caveat">Status reflects recorded resource state, not verified end-to-end product health. Unknown is never green.</span>
      </aside>
    </div>
    <footer className="universe-bottom">
      <span>Tap a node to inspect · Tap GetDone to reset</span>
      <div className="universe-legend"><span>🟢 Healthy</span><span>🟡 Attention</span><span>🔴 Critical</span><span>⚪ Unknown</span></div>
    </footer>
    {nodes.length>18 && <p className="universe-overflow">Showing 18 of {nodes.length} registered resources. More are available in Resources.</p>}
  </section>;
}
