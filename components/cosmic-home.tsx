import { Link } from "@tanstack/react-router";
import { BarChart3, ChevronRight, CircleCheck, Hexagon } from "lucide-react";
import { needsAttention, type ObjectiveView } from "@/lib/data/repository";
import type { Decision } from "@/lib/types";
const shortTitle = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t);

type Status = "running" | "attention" | "approval" | "done";
const STATUS_LABEL: Record<Status, string> = { running: "Running", attention: "Needs Attention", approval: "Needs Approval", done: "Completed" };

// Fixed orbital slots (percent of stage), planet skin, size, and tag side.
const SLOTS = [
  { x: 24, y: 30, skin: "earth", size: 92, tag: "left" },
  { x: 66, y: 22, skin: "mars", size: 70, tag: "right" },
  { x: 80, y: 46, skin: "saturn", size: 78, tag: "right" },
  { x: 27, y: 62, skin: "jupiter", size: 104, tag: "left" },
  { x: 70, y: 70, skin: "moon", size: 66, tag: "right" },
  { x: 44, y: 82, skin: "ocean", size: 62, tag: "left" },
  { x: 14, y: 46, skin: "molten", size: 54, tag: "left" },
] as const;

export function CosmicHome({ pending, active, closed, ownerInitial }: { pending: Decision[]; active: ObjectiveView[]; closed: ObjectiveView[]; ownerInitial?: string }) {
  const approvalIds = new Set(pending.map((d) => d.objectiveId).filter(Boolean));
  const statusOf = (o: ObjectiveView): Status => approvalIds.has(o.id) ? "approval" : needsAttention(o) ? "attention" : "running";
  const worlds = [
    ...active.map((o) => ({ o, s: statusOf(o) })).sort((a, b) => order(a.s) - order(b.s)),
    ...closed.map((o) => ({ o, s: "done" as Status })),
  ].slice(0, SLOTS.length);

  const running = active.filter((o) => statusOf(o) === "running").length;
  const attention = active.filter(needsAttention).length;

  return (
    <section className="cz" aria-label="Command center">
      <div className="cz-stars" aria-hidden />
      <div className="cz-nebula" aria-hidden />
      <div className="cz-horizon" aria-hidden />

      <header className="cz-bar">
        <div className="cz-brand"><Hexagon size={22} className="cz-hex" /><span>GetDone</span></div>
        <div className="cz-metrics">
          <Metric icon={<BarChart3 size={15} />} n={active.length + closed.length} label="Objectives" to="/running" />
          <Metric dot="running" n={running} label="Running" to="/running" />
          <Metric dot="attention" n={attention} label="Attention" to="/running" />
          <Metric dot="approval" n={pending.length} label="Needs Approval" to="/decisions" />
        </div>
        <div className="cz-right">
          <Link to="/completed" className="cz-growth"><CircleCheck size={15} /><b>{closed.length}</b><small>Completed</small></Link>
          <Link to="/autonomy" className="cz-avatar" aria-label="Settings">{ownerInitial ?? "D"}</Link>
        </div>
      </header>

      <div className="cz-stage">
        <div className="cz-orbits" aria-hidden>{[1, 2, 3, 4].map((i) => <span key={i} style={{ ["--r" as string]: i }} />)}</div>
        <div className="cz-sun"><span>GetDone</span></div>

        {worlds.map(({ o, s }, i) => {
          const slot = SLOTS[i]!;
          const decision = s === "approval" ? pending.find((d) => d.objectiveId === o.id) : undefined;
          return (
            <div key={o.id} className={`cz-world tag-${slot.tag}`} style={{ left: `${slot.x}%`, top: `${slot.y}%` }}>
              <span className={`cz-planet ${slot.skin}`} style={{ width: slot.size, height: slot.size }} />
              {decision ? (
                <Link to="/decisions/$decisionId" params={{ decisionId: decision.id }} className="cz-tag"><TagBody title={o.objective} s={s} /></Link>
              ) : (
                <Link to={s === "done" ? "/completed" : "/running"} className="cz-tag"><TagBody title={o.objective} s={s} /></Link>
              )}
            </div>
          );
        })}
        {!worlds.length ? <p className="cz-empty">No work in orbit yet. Tell GetDone what to get done below.</p> : null}
      </div>
    </section>
  );
}

function order(s: Status) { return s === "approval" ? 0 : s === "attention" ? 1 : 2; }

function TagBody({ title, s }: { title: string; s: Status }) {
  return (<><span className="cz-tag-text"><strong>{shortTitle(title, 26)}</strong><small><i className={`cz-dot ${s}`} />{STATUS_LABEL[s]}</small></span><ChevronRight size={14} /></>);
}

function Metric({ icon, dot, n, label, to }: { icon?: React.ReactNode; dot?: Status; n: number; label: string; to: "/running" | "/decisions" }) {
  return <Link to={to} className="cz-metric">{icon ?? <i className={`cz-dot ${dot}`} />}<b>{n}</b><small>{label}</small></Link>;
}
