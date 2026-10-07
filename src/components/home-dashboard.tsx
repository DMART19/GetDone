import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, ChevronRight, Megaphone, Rocket, TrendingUp, UserPlus } from "lucide-react";
import { useState } from "react";
import { needsAttention, type ObjectiveView } from "@/lib/data/repository";
import { CosmicHome } from "@/components/cosmic-home";
import { CommandChat } from "@/components/command-chat";
import { HealthSummary } from "@/components/health-card";
import { DecisionBriefing } from "@/components/decision-briefing";
import { controlObjective } from "@/lib/control.functions";
import { isHighImpact } from "@/lib/decision-insights";
import { plainState } from "@/lib/plain-language";
import { classify } from "@/lib/failure-classifier";
import type { Decision } from "@/lib/types";

const start = [
  { label: "Grow revenue", icon: TrendingUp, prompt: "Find the best revenue growth opportunity and make a plan." },
  { label: "Launch something", icon: Rocket, prompt: "Plan the launch of our next product or feature." },
  { label: "Run marketing", icon: Megaphone, prompt: "Plan a marketing push for this month." },
  { label: "Find or hire", icon: UserPlus, prompt: "Help me find or hire someone for " },
] as const;

/** Short, scannable card title; the full request stays in the detail view. */
export function shortTitle(text: string, max = 52) {
  const clean = text.replace(/\s+/g, " ").trim();
  const first = clean.split(/(?<=\w)[.;:!?](?:\s|$)|\n| — /)[0]!.trim() || clean;
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : max).trim() + "…";
}

function FailedRow({ o, onEdit }: { o: ObjectiveView; onEdit: (t: string) => void }) {
  const router = useRouter();
  const control = useServerFn(controlObjective);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  const [open, setOpen] = useState(false);
  const c = classify(o.jobs);
  const raw = c.job?.error ?? o.evaluation_summary;
  async function run(action: "retry" | "cancel" | "dismiss", confirm?: "dependency_fixed" | "try_anyway") {
    if (action === "cancel" && !window.confirm("Cancel this task?")) return;
    setBusy(true); setMsg(null);
    try { const r = await control({ data: { id: o.id, action, confirm } }); if (!r.ok) setMsg(r.error); else { setReview(false); setMsg(action === "retry" ? "Retrying…" : "Done."); router.invalidate(); } }
    catch { setMsg("Couldn't do that. Try again."); } finally { setBusy(false); }
  }
  function primary() {
    if (c.action === "retry") return run("retry");
    if (c.action === "edit") return onEdit(o.goal);
    if (c.action === "resolve") return router.navigate({ to: "/integrations" });
    if (c.action === "details") return router.navigate({ to: "/running" });
    if (c.action === "review_result") return setOpen((v) => !v);
    setReview(true);
  }
  return (
    <div className="gd-feed-item">
      <span className="gd-tl-dot bad" />
      <span className="gd-feed-body">
        <strong>{shortTitle(o.objective)}</strong>
        <small>{c.headline}</small>
        <small className="gd-muted">Attempt {c.attempt}{c.repeated ? " · retry limit reached" : c.maxAttempts > 1 ? ` of ${c.maxAttempts}` : ""}{c.job?.updated_at ? ` · last tried ${new Date(c.job.updated_at).toLocaleString()}` : ""} · {c.retryRecommended ? "Retry may help" : "Retrying unchanged is unlikely to help"}</small>
        {open || c.action !== "review_result" ? <details className="gd-feed-tech" open={open}><summary>{c.job?.receipt ? "Quality check notes" : "Technical details"}</summary><code>{c.reason}</code>{raw && raw !== c.reason ? <code>{raw}</code> : null}</details> : null}
        {review ? (
          <span className="gd-feed-tech" role="dialog" aria-label="Retry this task?">
            <strong>Retry this task?</strong>
            <small>Failed {c.attempt} {c.attempt === 1 ? "time" : "times"}. Last reason: {c.reason}</small>
            <small>Another attempt may fail the same way. Pick what's different this time:</small>
            <span className="gd-feed-actions">
              <button type="button" className="gd-btn gd-btn-gold" onClick={() => { setReview(false); onEdit(o.goal); }}>Edit the request</button>
              <button type="button" className="gd-link-btn" disabled={busy} onClick={() => run("retry", "dependency_fixed")}>I fixed what was missing</button>
              <button type="button" className="gd-link-btn" disabled={busy} onClick={() => run("retry", "try_anyway")}>Try again anyway</button>
              <button type="button" className="gd-link-btn" onClick={() => setReview(false)}>Close</button>
            </span>
          </span>
        ) : null}
        <span className="gd-feed-actions">
          <button type="button" className="gd-btn gd-btn-gold" disabled={busy} onClick={primary}>{c.actionLabel}</button>
          {c.action !== "edit" ? <button type="button" className="gd-link-btn" onClick={() => onEdit(o.goal)}>Edit request</button> : null}
          {c.action !== "retry" && c.action !== "review_before_retry" ? <button type="button" className="gd-link-btn" disabled={busy} onClick={() => (c.retryRecommended ? run("retry") : setReview(true))}>Retry with changes</button> : null}
          <Link to="/running" className="gd-link-btn">Details</Link>
          <button type="button" className="gd-link-btn" disabled={busy} onClick={() => run("cancel")}>Cancel task</button>
          <button type="button" className="gd-link-btn" disabled={busy} onClick={() => run("dismiss")}>Dismiss</button>
        </span>
        {msg ? <small role="status">{msg}</small> : null}
      </span>
    </div>
  );
}

type FeedTab = "active" | "attention" | "completed";

export function HomeDashboard({ pending = [], active = [], closed = [] }: { pending?: Decision[]; active?: ObjectiveView[]; closed?: ObjectiveView[] }) {
  const [message, setMessage] = useState("");
  const working = active.filter((o) => o.status === "active" && !needsAttention(o));
  const failed = active.filter(needsAttention);
  const [tab, setTab] = useState<FeedTab>(failed.length ? "attention" : working.length ? "active" : "completed");
  const edit = (t: string) => { setMessage(t); window.scrollTo({ top: 0, behavior: "smooth" }); document.querySelector<HTMLInputElement>(".gd-ask input, .gd-ask textarea")?.focus(); };

  const ranked = [...pending].sort((a, b) => Number(isHighImpact(b)) - Number(isHighImpact(a)) || (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const hero = ranked[0];

  const calm = failed.length
    ? `${failed.length === 1 ? "1 item needs" : `${failed.length} items need`} attention.`
    : working.length ? `All systems running smoothly. ${working.length} ${working.length === 1 ? "job" : "jobs"} in progress.`
    : "You're clear. Nothing is running right now.";

  const tabs: [FeedTab, string, number][] = [["active", "Active", working.length], ["attention", "Needs attention", failed.length], ["completed", "Completed", closed.length]];

  return (
    <div className="gd-page gd-home gd-cosmic">
      <CosmicHome pending={pending} active={active} closed={closed} />
      <div className="cz-command">
        <CommandChat message={message} setMessage={setMessage} placeholder="What do you want to know or get done today?" />
      </div>
      <div className="gd-examples" aria-label="Suggestions">
        {start.map(({ label, icon: Icon, prompt }) => <button key={label} type="button" onClick={() => edit(prompt)}><Icon size={14} /> {label}</button>)}
      </div>
      {hero ? (
        <section aria-label="Needs your decision">
          <p className="gd-eyebrow">Needs your decision</p>
          <DecisionBriefing d={hero} hero extra={pending.length - 1} />
        </section>
      ) : (
        <div className="gd-calm"><CheckCircle2 size={20} className={failed.length ? "gd-gold" : "gd-green"} /><span>{calm}</span></div>
      )}


      <section className="gd-feed" aria-label="Work">
        <div className="gd-seg" role="tablist">
          {tabs.map(([k, l, n]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{l} <span>{n}</span></button>
          ))}
        </div>
        <div className="gd-feed-list">
          {tab === "active" ? (working.length ? working.slice(0, 5).map((o) => {
            const job = o.jobs.find((j) => j.state !== "verified" && j.state !== "awaiting_approval") ?? o.jobs[0];
            return (
              <Link key={o.id} to="/running" className="gd-feed-item">
                <span className="gd-tl-dot active" />
                <span className="gd-feed-body"><strong>{shortTitle(o.objective)}</strong><small>{job ? `${shortTitle(job.step.title, 40)} · ${plainState(job.state)}` : "Planning"}</small></span>
                <ChevronRight size={16} />
              </Link>
            );
          }) : <p className="gd-muted">Nothing running right now.</p>) : null}
          {tab === "attention" ? (failed.length ? failed.slice(0, 5).map((o) => <FailedRow key={o.id} o={o} onEdit={edit} />) : <p className="gd-muted">Nothing needs attention.</p>) : null}
          {tab === "completed" ? (closed.length ? closed.slice(0, 5).map((o) => (
            <Link key={o.id} to="/completed" className="gd-feed-item">
              <span className="gd-tl-dot done" />
              <span className="gd-feed-body"><strong>{shortTitle(o.objective)}</strong><small>{o.evaluation === "partially_completed" ? "Partly done" : "Verified"}{o.evaluation_summary ? ` · ${shortTitle(o.evaluation_summary, 70)}` : ""}</small></span>
              <ChevronRight size={16} />
            </Link>
          )) : <p className="gd-muted">Verified results will show up here.</p>) : null}
        </div>
      </section>

      <HealthSummary />
    </div>
  );
}
