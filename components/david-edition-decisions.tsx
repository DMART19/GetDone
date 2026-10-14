"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown, ChevronRight, CheckCircle2, CircleAlert, Filter, LockKeyhole, Orbit, Search, ShieldCheck, Sparkles, X } from "lucide-react";
import { DecisionActions } from "@/components/decision-actions";
import type { Decision } from "@/lib/types";

const categoryLabel: Record<Decision["category"], string> = {
  resource: "RESOURCE", growth: "RELEASE", incident: "INCIDENT", budget: "BUDGET", outreach: "OUTREACH"
};

function decisionDetailUrl(id: string) { return "/decisions/" + encodeURIComponent(id); }

export function DavidEditionDecisionCommand({ decisions }: { decisions: Decision[] }) {
  const [query, setQuery] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [category, setCategory] = useState("All");
  const [sort, setSort] = useState<"Priority" | "Recent">("Priority");
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  const activeCount = decisions.filter(d => d.status === "pending" && d.priority !== "fyi").length;
  const resolvedCount = decisions.filter(d => d.status !== "pending").length;
  const pending = useMemo(() => {
    const filtered = decisions.filter(d => (
      (showHistory || (d.status === "pending" && d.priority !== "fyi")) &&
      (category === "All" || d.category === category) &&
      (d.title + " " + d.subtitle + " " + d.rationale + " " + d.category).toLowerCase().includes(query.trim().toLowerCase())
    ));
    if (sort === "Priority") filtered.sort((a, b) => Number(b.priority === "high") - Number(a.priority === "high"));
    return filtered;
  }, [decisions, showHistory, category, query, sort]);

  const selected = pending.find(d => d.id === chosenId) ?? pending[0];
  const remaining = pending.filter(d => d.id !== selected?.id);
  const needsStepUp = selected?.priority === "high";

  return <section className="de37" aria-label="David Edition owner decision bridge">
    <div className="de37-title-bar"><span><Orbit size={14}/> DAVID EDITION / OWNER 01 / RESOLVE FIRST</span><Link href="/">← Universe</Link></div>
    <div className="de37-hero"><div><div className="de37-kicker">● OWNER ATTENTION RADAR · AUTHENTICATED DATA</div><h1>{activeCount ? `${activeCount} decision${activeCount === 1 ? "" : "s"} need you.` : "Your decision queue is clear."}</h1><p>Review evidence and take authorized action in one place.</p></div><div className="de37-indicators"><span className="de37-wait"><CircleAlert size={14}/>{activeCount} awaiting owner</span><span><ShieldCheck size={14}/>Live decision records</span><span><CheckCircle2 size={14}/>{resolvedCount} resolved</span></div></div>
    <div className="de37-toolbar"><label className="de37-search"><Search size={17}/><input aria-label="Find a decision" value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a decision, business or issue…"/>{query && <button type="button" aria-label="Clear search" onClick={() => setQuery("")}><X size={15}/></button>}</label><button type="button" onClick={() => setShowFilters(v => !v)} aria-expanded={showFilters}><Filter size={15}/> Filters <ChevronDown size={15}/></button><button type="button" onClick={() => { setShowHistory(v => !v); setChosenId(null); setInspectorOpen(false); }}>{showHistory ? "Open queue" : "History"}</button></div>
    {showFilters && <div className="de37-filters"><label>Category <select value={category} onChange={e => { setCategory(e.target.value); setChosenId(null); }}><option>All</option>{Object.keys(categoryLabel).map(key => <option key={key} value={key}>{categoryLabel[key as Decision["category"]]}</option>)}</select></label><label>Sort <select value={sort} onChange={e => setSort(e.target.value as "Priority" | "Recent")}><option>Priority</option><option>Recent</option></select></label></div>}
    {selected ? <div className={`de37-workspace ${inspectorOpen ? "de37-expanded" : ""}`}>
      <div className="de37-primary-column"><article className="de37-feature">
        <div className="de37-feature-top"><span><ShieldCheck size={16}/> NEXT OWNER ACTION · GOVERNED BACKEND</span><span className={selected.status === "pending" ? "de37-tag" : "de37-tag resolved"}>{selected.status}</span></div>
        <div className="de37-context">{categoryLabel[selected.category]} · {selected.age} · {selected.priority.toUpperCase()} PRIORITY</div>
        <h2>{selected.title}</h2><p className="de37-desc">{selected.subtitle}</p>
        <div className="de37-essentials"><div><small>WHY IT MATTERS</small><strong>{selected.rationale}</strong></div><div><small>WHAT YOU NEED TO DO</small><strong>{selected.status === "pending" ? (selected.actionLabel ?? "Review and authorize the proposed decision") : "No further action requested"}</strong></div></div>
        {selected.status === "pending" ? <div className="de37-direct-action"><div className="de37-direct-head"><span><LockKeyhole size={15}/> SECURE DECISION</span><small>{needsStepUp ? "HIGH PRIORITY" : "SERVER-VERIFIED"}</small></div><p>This action uses GetDone's existing authenticated decision endpoint. Approval may require a passkey challenge. No direct execution is bypassed.</p><DecisionActions key={selected.id} decisionId={selected.id} initialStatus={selected.status} approveLabel={selected.actionLabel ?? "Approve"}/></div> : <div className="de37-done"><CheckCircle2 size={17}/> Decision status: {selected.status}.</div>}
        <div className="de37-support-actions"><button type="button" onClick={() => setInspectorOpen(v => !v)} aria-expanded={inspectorOpen}><ShieldCheck size={16}/>{inspectorOpen ? "Hide supporting evidence" : "Show evidence & related systems"}</button><Link href={decisionDetailUrl(selected.id)}><ArrowRight size={16}/> Full decision record</Link></div>
      </article>
      <div className="de37-queue-heading"><div><strong>Remaining queue</strong><small>{remaining.length} other record{remaining.length === 1 ? "" : "s"}</small></div><span>OWNER 01 / LIVE RECORDS</span></div>
      <div className="de37-queue">{remaining.map(d => <button className="de37-queue-item" key={d.id} onClick={() => { setChosenId(d.id); setInspectorOpen(false); }} type="button"><span className="de37-record-icon"><ShieldCheck size={18}/></span><span className="de37-record-content"><small>{categoryLabel[d.category]} · {d.age}</small><strong>{d.title}</strong><span>{d.subtitle}</span></span><span className="de37-tag">{d.status}</span><ChevronRight size={17}/></button>)}</div>
      </div>
      {inspectorOpen && <aside className="de37-inspector"><div className="de37-inspector-header"><span><Orbit size={16}/> MISSION INSPECTOR</span><span>READ-ONLY EVIDENCE</span></div><h3>{selected.title}</h3><section><small>REQUEST CONTEXT</small><p>{selected.subtitle}</p></section><section><small>REASONING / RATIONALE</small><p>{selected.rationale}</p></section><section><small>IMPACT</small>{selected.impact.map((e,i) => <p key={i}>{e}</p>)}</section><section><small>EVIDENCE</small>{selected.evidence?.length ? selected.evidence.map((e,i) => <p key={i}>{e}</p>) : <p>No additional verified evidence was provided with this decision record.</p>}</section>{selected.blastRadius && <section><small>BLAST RADIUS</small><p>{selected.blastRadius}</p></section>}<div className="de37-secure-note"><LockKeyhole size={16}/> All mutations are authenticated and audited by GetDone. This panel does not authorize anything.</div></aside>}
    </div> : <div className="de37-empty"><CheckCircle2 size={28}/><h2>{showHistory ? "No matching decisions" : "Nothing requires your judgment"}</h2><p>{showHistory ? "Try another search or filter." : "GetDone will surface your next owner-level decision here."}</p>{(query || category !== "All") && <button onClick={() => { setQuery(""); setCategory("All"); }}>Clear filters</button>}</div>}
    <div className="de37-footer"><LockKeyhole size={15}/> DAVID EDITION · AUTHENTICATED GETDONE DECISIONS · GOVERNED APPROVALS</div>
  </section>;
}
