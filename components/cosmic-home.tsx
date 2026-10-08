import { Link } from "@tanstack/react-router";
import { BarChart3, CircleCheck, Hexagon } from "lucide-react";
import { needsAttention, type ObjectiveView } from "@/lib/data/repository";
import type { Decision } from "@/lib/types";
const shortTitle = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t);

type Status = "running" | "attention" | "approval" | "done";
const STATUS_LABEL: Record<Status, string> = { running: "Running", attention: "Needs Attention", approval: "Needs Approval", done: "Completed" };

// Fixed orbital slots (percent of stage), planet skin, size, and tag side.
// Companies plugged into GetDone — each is one planet.
const COMPANIES = ["OpsManagerPro"];

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
  const running = active.filter((o) => statusOf(o) === "running").length;
  const attention = active.filter(needsAttention).length;
  // Every connected company is one planet; its status rolls up the work done for it.
  const companyStatus: Status = pending.length ? "approval" : attention ? "attention" : active.length ? "running" : "done";
  const worlds = COMPANIES.slice(0, SLOTS.length).map((name) => ({ name, s: companyStatus }));

  return (
    <section className="cz" aria-label="Command center">
      <div className="cz-stars" aria-hidden />
      <div className="cz-nebula" aria-hidden />
      <div className="cz-horizon" aria-hidden />

      <header className="cz-bar">
        <div className="cz-brand"><Hexagon size={22} className="cz-hex" /><span>GetDone</span></div>
        <div className="cz-metrics">
          <Metric icon={<BarChart3 size={15} />} n={COMPANIES.length} label="Businesses" to="/running" />
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

        {worlds.map(({ name, s }, i) => {
          const slot = SLOTS[i]!;
          const to = s === "approval" ? "/decisions" : s === "done" ? "/completed" : "/running";
          return (
            <Link key={name} to={to} className={`cz-world tag-${slot.tag}`} style={{ left: `${slot.x}%`, top: `${slot.y}%` }} aria-label={`${name}: ${STATUS_LABEL[s]}`}>
              <span className={`cz-planet ${slot.skin}`} style={{ width: slot.size, height: slot.size }} />
              <span className="cz-tag"><i className={`cz-dot ${s}`} /><strong>{name}</strong></span>
            </Link>
          );
        })}
        {!worlds.length ? <p className="cz-empty">No businesses connected yet.</p> : null}
      </div>
    </section>
  );
}

function order(s: Status) { return s === "approval" ? 0 : s === "attention" ? 1 : 2; }

function Metric({ icon, dot, n, label, to }: { icon?: React.ReactNode; dot?: Status; n: number; label: string; to: "/running" | "/decisions" }) {
  return <Link to={to} className="cz-metric">{icon ?? <i className={`cz-dot ${dot}`} />}<b>{n}</b><small>{label}</small></Link>;
}
