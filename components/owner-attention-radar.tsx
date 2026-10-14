import Link from "next/link";
import type { Decision, ObjectiveView } from "@/lib/types";

/** Read-only owner radar. All counts and links derive from authorized server reads. */
export function OwnerAttentionRadar({
  objectives, decisions
}: { objectives: readonly ObjectiveView[]; decisions: readonly Decision[] }) {
  const approvals = decisions.filter(item => item.status === "pending" && item.priority !== "fyi");
  const input = objectives.filter(item => item.status === "needs_owner_input");
  const blocked = objectives.filter(item => item.status === "blocked" || item.status === "failed");
  const active = objectives.filter(item => ["queued", "planning", "executing", "new_work_required"].includes(item.status));
  const priorities = [
    ...approvals.map(item => ({ id: `decision-${item.id}`, title: item.title, label: "Approval needed", href: "/decisions" })),
    ...input.map(item => ({ id: `input-${item.id}`, title: item.title, label: "Owner input needed", href: `/objectives/${encodeURIComponent(item.id)}` })),
    ...blocked.map(item => ({ id: `blocked-${item.id}`, title: item.title, label: "Blocked / failed", href: `/objectives/${encodeURIComponent(item.id)}` }))
  ].slice(0, 6);

  return <section className="de-owner-radar" aria-label="Owner attention radar">
    <header><div><span className="de-eyebrow">OWNER ATTENTION · AUTHORIZED RECORDS</span><h2>What needs you</h2></div><Link href="/decisions">Open decisions →</Link></header>
    <div className="de-owner-radar-metrics">
      <div><strong>{approvals.length}</strong><span>Pending approvals</span></div>
      <div><strong>{input.length}</strong><span>Needs your input</span></div>
      <div><strong>{blocked.length}</strong><span>Blocked or failed</span></div>
      <div><strong>{active.length}</strong><span>In progress</span></div>
    </div>
    {priorities.length ? <ul>{priorities.map(item => <li key={item.id}><span>{item.label}</span><Link href={item.href}>{item.title} →</Link></li>)}</ul> : <p>No unresolved owner-attention items in the current authorized snapshot.</p>}
    <small>Read-only snapshot. Execution and completion require authoritative worker and verification evidence.</small>
  </section>;
}
